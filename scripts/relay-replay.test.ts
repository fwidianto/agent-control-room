import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildRelayReplayMessages } from './relay-replay'
import type { AgentEvent, SessionInfo } from '../extension/src/protocol'
import type { OrchestrationEvent } from '../extension/src/orchestration-events'
import { WorkflowIdentityReader, enrichSessionList } from '../extension/src/workflow-identity'
import { reduceOrchestrationSnapshot } from '../web/lib/orchestration-state'

const sessions: SessionInfo[] = [
  { id: 'inactive', label: 'Inactive', status: 'completed', startTime: 1, lastActivityTime: 3 },
  { id: 'active', label: 'Active', status: 'active', startTime: 1, lastActivityTime: 2 },
]
const orchestration: OrchestrationEvent[] = [{ eventId: 'workflow', eventVersion: 1, type: 'workflow_started', timestamp: '2026-07-17T00:00:00.000Z', workflowId: 'workflow-1', source: 'launcher' }]
const activity = (sessionId: string): AgentEvent => ({ time: 0, type: 'message', payload: {}, sessionId })

test('relay reconnect resets browser state before authoritative replay', () => {
  const messages = buildRelayReplayMessages(orchestration, sessions, new Map([
    ['inactive', [activity('inactive')]], ['active', [activity('active')]],
  ])) as Array<{ type: string; events?: AgentEvent[] }>
  assert.deepEqual(messages.slice(0, 3).map(message => message.type), ['reset', 'orchestration-snapshot', 'session-list'])
  assert.deepEqual(messages.slice(3).map(message => message.events?.[0].sessionId), ['active', 'inactive'])
})

test('relay reconnect sends an empty session list after reset', () => {
  const messages = buildRelayReplayMessages([], [], new Map()) as Array<{ type: string; sessions?: SessionInfo[] }>
  assert.equal(messages[0].type, 'reset')
  assert.deepEqual(messages[2], { type: 'session-list', sessions: [] })
})

test('reader-to-relay replay preserves explicit membership and leaves legacy sessions ungrouped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-flow-replay-integration-'))
  const file = join(dir, 'orchestration.jsonl')
  try {
    writeFileSync(file, `${JSON.stringify({
      eventId: 'membership', eventVersion: 1, type: 'workflow_session_registered', timestamp: '2026-07-17T00:00:00.000Z',
      workflowId: 'workflow-1', workflowName: 'Release', workflowCreatedAt: '2026-07-17T00:00:00.000Z',
      workflowSource: 'launcher', source: 'launcher', sessionId: 'active', runtime: 'codex',
    })}\nmalformed\n`)
    const reader = new WorkflowIdentityReader(file)
    reader.refresh()
    const replaySessions = enrichSessionList(reader, sessions.map(session => ({ ...session, runtime: 'codex' as const })))
    const messages = buildRelayReplayMessages(reader.getOrchestrationEvents(), replaySessions, new Map()) as Array<{ type: string; events?: OrchestrationEvent[]; sessions?: SessionInfo[] }>
    const state = reduceOrchestrationSnapshot(messages.find(message => message.type === 'orchestration-snapshot')!.events!)
    assert.equal(state.memberships.get('active')?.workflowId, 'workflow-1')
    assert.equal(messages.find(message => message.type === 'session-list')!.sessions!.find(session => session.id === 'inactive')?.workflow, undefined)
    assert.deepEqual(reader.getDiagnostics().map(item => item.code), ['malformed'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
