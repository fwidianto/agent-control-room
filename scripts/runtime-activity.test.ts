import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentEvent, SessionInfo } from '../web/lib/bridge-types'
import {
  MAX_RUNTIME_ACTIVITY, createRuntimeActivityState, normalizeAgentEvent, normalizeReturnActivity,
  reduceRuntimeActivity, replayRuntimeActivity, runtimeActivityList, runtimeActivityReplayEnd, sanitizeCommand, sanitizePath, visibleRuntimeActivity,
} from '../web/lib/runtime-activity'

const workspace = 'C:/workspace/agent-flow'
const session = (runtime: SessionInfo['runtime'] = 'claude'): SessionInfo => ({
  id: 'session-1', label: 'safe session', status: 'active', startTime: 1_000, lastActivityTime: 1_000,
  runtime, workspace, workflow: {
    workflowId: 'workflow-1', workflowName: 'Safe workflow', workflowCreatedAt: new Date(1_000).toISOString(),
    workflowSource: 'test', provenance: 'Explicit orchestration event',
  },
})

function event(type: AgentEvent['type'], payload: Record<string, unknown>, time = 1): AgentEvent {
  return { type, time, payload, sessionId: 'session-1' }
}

test('normalizes Claude file read and edit distinctly with stable tool-use identity', () => {
  const read = normalizeAgentEvent(event('tool_call_start', {
    agent: 'worker', tool: 'Read', callId: 'read-1', args: 'src/a.ts', inputData: { file_path: 'C:/workspace/agent-flow/src/a.ts' },
  }), session())!
  const edit = normalizeAgentEvent(event('tool_call_start', {
    agent: 'worker', tool: 'Edit', callId: 'edit-1', args: 'src/a.ts', inputData: { file_path: 'C:/workspace/agent-flow/src/a.ts' },
  }), session())!

  assert.equal(read.operation, 'read')
  assert.equal(read.artifactType, 'file')
  assert.equal(read.label, 'Reading · src/a.ts')
  assert.equal(edit.operation, 'edit')
  assert.notEqual(read.id, edit.id)
})

test('normalizes Codex command and test evidence without claiming pass', () => {
  const start = normalizeAgentEvent(event('tool_call_start', {
    tool: 'exec', callId: 'cmd-1', args: 'const r = await tools.shell_command({command:"pnpm.cmd test"})',
  }), session('codex'))!
  const end = normalizeAgentEvent(event('tool_call_end', {
    tool: 'exec', callId: 'cmd-1', args: 'pnpm.cmd test', exitCode: 0,
  }, 2), session('codex'))!

  assert.equal(start.operation, 'test')
  assert.equal(start.artifactType, 'test')
  assert.equal(start.status, 'running')
  assert.equal(end.status, 'unknown')
  assert.equal(end.phase, 'complete')
  const notATest = normalizeAgentEvent(event('tool_call_start', {
    tool: 'Bash', callId: 'cmd-2', inputData: { command: 'echo test' },
  }), session('codex'))!
  assert.equal(notATest.operation, 'execute')
  const inspect = normalizeAgentEvent(event('tool_call_start', {
    tool: 'Bash', callId: 'cmd-3', inputData: { command: 'git diff -- src/a.ts' },
  }), session('codex'))!
  assert.equal(inspect.operation, 'inspect')
})

test('normalizes patch evidence without exposing patch contents', () => {
  const activity = normalizeAgentEvent(event('tool_call_start', {
    tool: 'apply_patch', callId: 'patch-1', args: 'apply patch',
    inputData: { patch: '*** Begin Patch\n*** Update File: C:/workspace/agent-flow/src/safe.ts\n-SECRET CONTENT' },
  }), session('codex'))!

  assert.equal(activity.operation, 'apply_patch')
  assert.equal(activity.label, 'Applying patch · src/safe.ts')
  assert.equal(activity.label.includes('SECRET'), false)
})

test('ignores unsupported activity events and keeps review/finding unavailable', () => {
  assert.equal(normalizeAgentEvent(event('message', { content: 'review findings' }), session()), null)
  assert.equal(normalizeAgentEvent(event('tool_call_start', { tool: 'unknown-review-helper', args: 'findings' }), session())?.operation, 'tool')
})

test('redacts secrets and absolute paths', () => {
  assert.equal(sanitizePath('C:/workspace/agent-flow/.env', workspace), 'Protected file')
  assert.equal(sanitizePath('C:/Users/fauzan/private.txt', workspace), 'External file')
  const command = sanitizeCommand('TOKEN=secret pnpm test --token=abc https://user:pass@example.com/a C:/workspace/agent-flow/src/a.ts', workspace)!
  assert.equal(command.includes('secret'), false)
  assert.equal(command.includes('abc'), false)
  assert.equal(command.includes('user:pass'), false)
  assert.equal(command.includes('C:/workspace'), false)
  const windows = sanitizeCommand('set API_KEY="secret value" && node C:\\Users\\fauzan\\private.js', workspace)!
  assert.equal(windows.includes('secret value'), false)
  assert.equal(windows.includes('C:\\Users\\fauzan'), false)
  const headers = sanitizeCommand('curl -H "Authorization: Basic dXNlcjpzZWNyZXQ=" -H "Cookie: session=private" https://example.test', workspace)!
  assert.equal(headers.includes('dXNlcjpzZWNyZXQ='), false)
  assert.equal(headers.includes('session=private'), false)
  const multiCookie = sanitizeCommand('curl -H Cookie:session=first; refresh=second --data safe', workspace)!
  assert.equal(multiCookie.includes('session=first'), false)
  assert.equal(multiCookie.includes('refresh=second'), false)
  const sensitiveHeaders = sanitizeCommand('curl -H "X-Api-Key: key-secret" -H "X-Token: token-secret" -H "Client-Secret: client-secret"', workspace)!
  assert.equal(sensitiveHeaders.includes('key-secret'), false)
  assert.equal(sensitiveHeaders.includes('token-secret'), false)
  assert.equal(sensitiveHeaders.includes('client-secret'), false)
})

test('deduplicates replay and pairs start/end deterministically', () => {
  const start = normalizeAgentEvent(event('tool_call_start', { tool: 'Read', callId: 'read-2', inputData: { file_path: 'src/a.ts' } }), session())!
  const end = normalizeAgentEvent(event('tool_call_end', { tool: 'Read', callId: 'read-2' }, 3), session())!
  let state = createRuntimeActivityState()
  state = reduceRuntimeActivity(state, start)
  state = reduceRuntimeActivity(state, start)
  state = reduceRuntimeActivity(state, end)
  state = reduceRuntimeActivity(state, end)
  const list = runtimeActivityList(state)
  assert.equal(list.length, 1)
  assert.equal(list[0].phase, 'complete')
  assert.equal(list[0].label, 'Reading \u00b7 src/a.ts')
  assert.equal(list[0].durationMs, 2_000)
})

test('normalizes authoritative return without inventing an outcome', () => {
  const activity = normalizeReturnActivity({
    eventId: 'return-1', timestamp: new Date(4_000).toISOString(), workflowId: 'workflow-1',
    sessionId: 'session-1', agentId: 'agent-1', type: 'agent_returned',
  })!
  assert.equal(activity.operation, 'return')
  assert.equal(activity.authority, 'authoritative')
  assert.equal(activity.status, 'unknown')
})

test('bounds retained activity history', () => {
  let state = createRuntimeActivityState()
  for (let index = 0; index < MAX_RUNTIME_ACTIVITY + 25; index++) {
    state = reduceRuntimeActivity(state, {
      id: `activity-${index}`, runtime: 'codex', sessionId: 'session-1', timestamp: index,
      callId: `call-${index}`, operation: 'tool', artifactType: 'tool', artifactId: `tool-${index}`,
      label: 'Using · tool', phase: 'complete', status: 'unknown', evidenceSource: 'codex-rollout',
      authority: 'observed', confidence: 'high', completedAt: index,
    })
  }
  assert.equal(state.events.size, MAX_RUNTIME_ACTIVITY)
  assert.equal(runtimeActivityList(state)[0].id, 'activity-25')
})

test('marks standalone completion events for bounded expiry', () => {
  const complete = normalizeAgentEvent(event('tool_call_end', { tool: 'Read', callId: 'read-expire' }, 2), session())!
  let state = createRuntimeActivityState()
  state = reduceRuntimeActivity(state, complete)
  assert.equal(complete.completedAt, 3_000)
  assert.equal(visibleRuntimeActivity(state, 3_000 + 12_000).length, 1)
  assert.equal(visibleRuntimeActivity(state, 3_001 + 12_000).length, 0)
})

test('keeps concurrent sessions and operations independently identifiable', () => {
  const first = normalizeAgentEvent(event('tool_call_start', { tool: 'Read', callId: 'read-concurrent', inputData: { file_path: 'src/one.ts' } }), session())!
  const second = normalizeAgentEvent({ ...event('tool_call_start', { tool: 'Bash', callId: 'command-concurrent', inputData: { command: 'pnpm test' } }), sessionId: 'session-2' }, { ...session('claude'), id: 'session-2' })!
  assert.notEqual(first.id, second.id)
  assert.equal(first.operation, 'read')
  assert.equal(second.operation, 'test')
  assert.notEqual(first.artifactId, second.artifactId)
})

test('pairs a reconnect replay even when completion arrives before start', () => {
  const start = normalizeAgentEvent(event('tool_call_start', { tool: 'Read', callId: 'reconnect-1', inputData: { file_path: 'src/reconnect.ts' } }, 1), session())!
  const end = normalizeAgentEvent(event('tool_call_end', { tool: 'Read', callId: 'reconnect-1' }, 3), session())!
  let state = createRuntimeActivityState()
  state = reduceRuntimeActivity(state, end)
  state = reduceRuntimeActivity(state, start)
  const [replayed] = runtimeActivityList(state)
  assert.equal(replayed.phase, 'complete')
  assert.equal(replayed.label, 'Reading \u00b7 src/reconnect.ts')
  assert.equal(replayed.durationMs, 2_000)
})

test('replay projects a paired call as running until its captured completion', () => {
  const start = normalizeAgentEvent(event('tool_call_start', { tool: 'Read', callId: 'replay-1', inputData: { file_path: 'src/replay.ts' } }, 1), session())!
  const end = normalizeAgentEvent(event('tool_call_end', { tool: 'Read', callId: 'replay-1' }, 4), session())!
  let state = createRuntimeActivityState()
  state = reduceRuntimeActivity(state, start)
  state = reduceRuntimeActivity(state, end)
  const [during] = replayRuntimeActivity(runtimeActivityList(state), 3_000)
  const [after] = replayRuntimeActivity(runtimeActivityList(state), 5_000)
  assert.equal(during.phase, 'start')
  assert.equal(during.status, 'running')
  assert.equal(after.phase, 'complete')
  assert.equal(after.completedAt, 5_000)
})

test('replay horizon includes the latest completion, not only the latest start', () => {
  const early = normalizeAgentEvent(event('tool_call_start', { tool: 'Read', callId: 'long-1' }, 1), session())!
  const earlyEnd = normalizeAgentEvent(event('tool_call_end', { tool: 'Read', callId: 'long-1' }, 9), session())!
  const later = normalizeAgentEvent(event('tool_call_start', { tool: 'Read', callId: 'later-1' }, 3), session())!
  let state = createRuntimeActivityState()
  state = reduceRuntimeActivity(state, early)
  state = reduceRuntimeActivity(state, earlyEnd)
  state = reduceRuntimeActivity(state, later)
  assert.equal(runtimeActivityReplayEnd(runtimeActivityList(state), 0), 10_000)
})
