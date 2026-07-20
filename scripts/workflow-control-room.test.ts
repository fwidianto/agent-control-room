import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { performance } from 'node:perf_hooks'
import { reduceOrchestrationSnapshot } from '../web/lib/orchestration-state'
import type { OrchestrationEvent, WorkflowIdentity } from '../web/lib/bridge-types'
import type { SessionSummary } from '../web/lib/session-summary'
import type { RuntimeActivityEvent } from '../web/lib/runtime-activity'
import { isCanvasClickGesture } from '../web/lib/interaction-gesture'
import { installFullscreenMode, shouldProcessCameraCommand } from '../web/lib/fullscreen-mode'
import {
  appendSessionActivity, buildAgentForest, buildWorkflowCanvasModel, buildWorkflowTimeline, CONTROL_ROOM_RENDER_LIMIT,
  CONTROL_ROOM_TIMELINE_LIMIT, filterWorkflowTimeline, partitionSessionActivity, workflowMetrics, workflowStatus,
  latestAgentEdgeInteraction, limitAgentForest, sessionOrchestrationContext,
} from '../web/lib/workflow-control-room'

let serial = 0
const event = (type: OrchestrationEvent['type'], overrides: Partial<OrchestrationEvent> = {}): OrchestrationEvent => ({
  eventId: `event-${serial++}`, eventVersion: 1, type, timestamp: '2026-07-17T00:00:00.000Z',
  workflowId: 'workflow-1', source: 'local launcher', ...overrides,
})
const workflow = (id = 'workflow-1', name = 'Release'): WorkflowIdentity => ({ workflowId: id, workflowName: name,
  workflowCreatedAt: '2026-07-17T00:00:00.000Z', workflowSource: 'local launcher', provenance: 'Explicit orchestration event' })
const session = (id: string, workflowIdentity?: WorkflowIdentity, status: SessionSummary['status'] = 'active'): SessionSummary => ({
  id, label: id, status, startTime: Date.parse('2026-07-17T00:00:00.000Z'), lastActivityTime: Date.parse('2026-07-17T00:01:00.000Z'),
  workflow: workflowIdentity, tokens: 100, tokensMax: 200,
})

test('separates explicit work status from session inactivity', () => {
  const inactive = session('session-1', workflow(), 'completed')
  assert.equal(workflowStatus('workflow-1', reduceOrchestrationSnapshot([]), [inactive]), 'Inactive')
  const completed = reduceOrchestrationSnapshot([event('workflow_completed')])
  assert.equal(workflowStatus('workflow-1', completed, [session('session-1', workflow())]), 'Completed')
  const failed = reduceOrchestrationSnapshot([event('assignment_failed', { assignmentId: 'assignment-1' })])
  assert.equal(workflowStatus('workflow-1', failed, [inactive]), 'Failed')
  const blocked = reduceOrchestrationSnapshot([event('assignment_blocked', { assignmentId: 'assignment-1' })])
  assert.equal(workflowStatus('workflow-1', blocked, [session('session-1', workflow())]), 'Blocked')
  const waiting = reduceOrchestrationSnapshot([event('agent_waiting', { agentId: 'agent-1' })])
  assert.equal(workflowStatus('workflow-1', waiting, [inactive]), 'Waiting')
  assert.equal(workflowStatus('workflow-1', waiting, [session('session-1', workflow())]), 'Active')
  const explicitWaiting = reduceOrchestrationSnapshot([event('workflow_updated', { status: 'waiting' })])
  assert.equal(workflowStatus('workflow-1', explicitWaiting, [session('session-1', workflow())]), 'Waiting')
  assert.equal(workflowStatus('workflow-1', reduceOrchestrationSnapshot([]), []), 'Unknown')
})

test('keeps multiple workflows isolated and handles missing context data', () => {
  const state = reduceOrchestrationSnapshot([
    event('agent_registered', { workflowId: 'workflow-1', agentId: 'agent', agentName: 'One' }),
    event('agent_registered', { workflowId: 'workflow-2', agentId: 'agent', agentName: 'Two' }),
  ])
  const one = workflowMetrics('workflow-1', state, [session('one', workflow('workflow-1'))], Date.parse('2026-07-17T00:02:00.000Z'))
  const two = workflowMetrics('workflow-2', state, [{ ...session('two', workflow('workflow-2')), tokens: undefined, tokensMax: undefined }], Date.parse('2026-07-17T00:02:00.000Z'))
  assert.deepEqual([one.agentCount, two.agentCount], [1, 1])
  assert.equal(one.tokens, 100)
  assert.equal(two.tokens, undefined)
  assert.equal(one.elapsedSeconds, 120)
})

test('counts every authoritative agent status without treating agent completion as workflow completion', () => {
  const statuses = ['active', 'waiting', 'blocked', 'returned', 'completed', 'failed'] as const
  const state = reduceOrchestrationSnapshot(statuses.map((status, index) => event('agent_status_updated', {
    eventId: `agent-status-${status}`, agentId: `agent-${index}`, status,
  })))
  const metrics = workflowMetrics('workflow-1', state, [], Date.parse('2026-07-17T00:02:00.000Z'))
  assert.deepEqual(metrics.counts.agents, { Active: 1, Waiting: 1, Blocked: 1, Returned: 1, Completed: 1, Failed: 1, Unknown: 0 })
  assert.equal(metrics.status, 'Failed')

  const completedOnly = reduceOrchestrationSnapshot([event('agent_status_updated', { agentId: 'agent', status: 'completed' })])
  assert.equal(workflowMetrics('workflow-1', completedOnly, [], Date.now()).status, 'Unknown')
})

test('stops workflow elapsed time only on explicit workflow completion and keeps explicit progress', () => {
  const state = reduceOrchestrationSnapshot([
    event('workflow_started', { timestamp: '2026-07-17T00:00:00.000Z' }),
    event('assignment_updated', { timestamp: '2026-07-17T00:00:30.000Z', assignmentId: 'assignment', metadata: { progressPercent: 40 } }),
    event('workflow_completed', { timestamp: '2026-07-17T00:01:00.000Z' }),
  ])
  const metrics = workflowMetrics('workflow-1', state, [], Date.parse('2026-07-17T00:10:00.000Z'))
  assert.equal(metrics.elapsedSeconds, 60)
  assert.equal(state.assignments.get('workflow-1\0assignment')?.progressPercent, 40)
  assert.deepEqual(metrics.counts, {
    agents: { Active: 0, Waiting: 0, Blocked: 0, Returned: 0, Completed: 0, Failed: 0, Unknown: 0 },
    assignments: { Active: 0, Waiting: 0, Blocked: 0, Completed: 0, Failed: 0, Unknown: 1 },
    sessions: { Active: 0, Waiting: 0, Inactive: 0 },
  })
})

test('uses hierarchy only for complete explicit registered delegations', () => {
  const hierarchical = reduceOrchestrationSnapshot([
    event('agent_registered', { agentId: 'parent', agentName: 'Parent' }),
    event('agent_registered', { agentId: 'child', agentName: 'Child' }),
    event('delegation_created', { agentId: 'child', parentAgentId: 'parent' }),
  ])
  const tree = buildAgentForest('workflow-1', hierarchical)
  assert.equal(tree.hierarchical, true)
  assert.equal(tree.roots[0].children[0].agent.agentId, 'child')

  const unresolved = reduceOrchestrationSnapshot([
    event('agent_registered', { agentId: 'child', agentName: 'Child' }),
    event('delegation_created', { agentId: 'child', parentAgentId: 'missing' }),
  ])
  assert.equal(buildAgentForest('workflow-1', unresolved).hierarchical, false)

  const capped = reduceOrchestrationSnapshot([
    ...Array.from({ length: 99 }, (_, index) => event('agent_registered', { agentId: `root-${index}` })),
    event('agent_registered', { agentId: 'child-before-parent' }),
    event('agent_registered', { agentId: 'parent-after-child' }),
    event('delegation_created', { agentId: 'child-before-parent', parentAgentId: 'parent-after-child' }),
  ])
  const limited = limitAgentForest(buildAgentForest('workflow-1', capped).roots, 100)
  const child = limited.flatMap(root => root.children).find(node => node.agent.agentId === 'child-before-parent')
  assert.equal(child, undefined)
  assert.equal(limited.some(root => root.agent.agentId === 'parent-after-child'), true)
  assert.equal(limited.some(root => root.agent.agentId === 'child-before-parent'), false)
})

test('builds selected-session identity and breadcrumb only from explicit orchestration relationships', () => {
  const state = reduceOrchestrationSnapshot([
    event('workflow_started', { workflowName: 'Native run' }),
    event('workflow_session_registered', { sessionId: 'root-session', runtime: 'codex' }),
    event('workflow_session_registered', { sessionId: 'luna-session', runtime: 'codex' }),
    event('agent_registered', { agentId: 'root', sessionId: 'root-session' }),
    event('agent_registered', { agentId: 'luna', agentName: 'Luna', agentRole: 'Worker', sessionId: 'luna-session' }),
    event('delegation_created', { agentId: 'luna', parentAgentId: 'root', sessionId: 'luna-session', parentSessionId: 'root-session' }),
    event('assignment_created', { assignmentId: 'implement', assignmentTitle: 'Implement native bridge', agentId: 'luna' }),
    event('agent_returned', { agentId: 'luna' }),
  ])
  const context = sessionOrchestrationContext('luna-session', state)
  assert.equal(context.workflowName, 'Native run')
  assert.equal(context.agentName, 'Luna')
  assert.equal(context.agentRole, 'Worker')
  assert.deepEqual(context.parent, { name: 'root', sessionId: 'root-session' })
  assert.equal(context.assignment, 'Implement native bridge')
  assert.equal(context.status, 'Returned')
  assert.deepEqual(context.breadcrumb.map(item => item.name), ['root', 'Luna'])
  const unknown = sessionOrchestrationContext('legacy-session', reduceOrchestrationSnapshot([]))
  assert.equal(unknown.agentName, 'Agent identity unavailable')
  assert.equal(unknown.parent, undefined)
  assert.deepEqual(unknown.children, [])
})

test('maps only authoritative lifecycle events onto hierarchy edges', () => {
  const state = reduceOrchestrationSnapshot([
    event('agent_registered', { agentId: 'luna', sessionId: 'luna-session' }),
    event('assignment_created', { assignmentId: 'work', agentId: 'luna' }),
    event('assignment_updated', { agentId: 'luna', assignmentId: 'work' }),
    event('assignment_started', { agentId: 'luna', assignmentId: 'work', timestamp: '2026-07-17T00:00:01.000Z' }),
    event('agent_returned', { agentId: 'luna', timestamp: '2026-07-17T00:00:02.000Z' }),
  ])
  assert.deepEqual(latestAgentEdgeInteraction('workflow-1', 'luna', state), {
    type: 'agent_returned', label: 'Returned', direction: 'in', timestamp: Date.parse('2026-07-17T00:00:02.000Z'),
  })
  assert.equal(latestAgentEdgeInteraction('workflow-1', 'terra', state), undefined)

  const lifecycle = reduceOrchestrationSnapshot([
    event('assignment_started', { agentId: 'luna', assignmentId: 'work' }),
    event('assignment_failed', { agentId: 'terra', assignmentId: 'review' }),
    event('agent_resumed', { agentId: 'sol' }),
  ])
  assert.equal(latestAgentEdgeInteraction('workflow-1', 'luna', lifecycle)?.direction, 'pulse')
  assert.equal(latestAgentEdgeInteraction('workflow-1', 'terra', lifecycle)?.direction, 'pulse')
  assert.equal(latestAgentEdgeInteraction('workflow-1', 'sol', lifecycle)?.direction, 'pulse')

  const missingOwner = reduceOrchestrationSnapshot([
    event('assignment_created', { assignmentId: 'moved', agentId: 'terra' }),
    event('assignment_started', { assignmentId: 'moved' }),
  ])
  assert.equal(latestAgentEdgeInteraction('workflow-1', 'terra', missingOwner), undefined)

  const resumedAfterReturn = reduceOrchestrationSnapshot([
    event('agent_returned', { agentId: 'luna', timestamp: '2026-07-17T00:00:01.000Z' }),
    event('agent_status_updated', { agentId: 'luna', status: 'active', timestamp: '2026-07-17T00:00:02.000Z' }),
  ])
  assert.equal(latestAgentEdgeInteraction('workflow-1', 'luna', resumedAfterReturn), undefined)

  for (const newer of [
    event('assignment_blocked', { agentId: 'luna', assignmentId: 'work', timestamp: '2026-07-17T00:00:02.000Z' }),
    event('assignment_updated', { agentId: 'luna', assignmentId: 'work', status: 'completed', timestamp: '2026-07-17T00:00:02.000Z' }),
    event('assignment_created', { agentId: 'luna', assignmentId: 'new-work', timestamp: '2026-07-17T00:00:02.000Z' }),
  ]) {
    const superseded = reduceOrchestrationSnapshot([
      event('assignment_started', { agentId: 'luna', assignmentId: 'work', timestamp: '2026-07-17T00:00:01.000Z' }), newer,
    ])
    assert.equal(latestAgentEdgeInteraction('workflow-1', 'luna', superseded), undefined)
  }
})

test('builds a bounded canvas model from explicit agents, sessions, and delegations', () => {
  const state = reduceOrchestrationSnapshot([
    event('workflow_session_registered', { sessionId: 'root-session', runtime: 'codex' }),
    event('workflow_session_registered', { sessionId: 'luna-session', runtime: 'codex' }),
    event('agent_registered', { agentId: 'root', agentName: 'Sol', sessionId: 'root-session' }),
    event('agent_registered', { agentId: 'luna', agentName: 'Luna', sessionId: 'luna-session' }),
    event('delegation_created', { agentId: 'luna', parentAgentId: 'root' }),
    event('assignment_created', { assignmentId: 'inspect', assignmentTitle: 'Inspect canvas', agentId: 'luna' }),
    event('agent_returned', { agentId: 'luna', timestamp: '2026-07-17T00:00:02.000Z' }),
  ])
  const sessions = [
    { ...session('root-session'), runtime: 'codex' as const, activity: 'Coordinating agents' },
    { ...session('luna-session'), runtime: 'codex' as const, activity: 'Inspecting source files' },
  ]
  const model = buildWorkflowCanvasModel('workflow-1', state, sessions, [])
  assert.equal(model.agents.size, 2)
  assert.equal(model.edges.length, 1)
  assert.equal(model.edges[0].from, 'root')
  assert.equal(model.agents.get('root')?.y, 0)
  assert.equal(model.agents.get('luna')?.y, 180)
  assert.equal(model.agents.get('luna')?.currentTool, 'Inspecting source files')
  assert.equal(model.agents.get('luna')?.task, 'Inspect canvas')
  assert.equal(model.agents.get('luna')?.messageBubbles.length, 0)
  assert.deepEqual(model.signals, [{ edgeId: 'edge-root-luna', direction: 'in', label: 'Returned', timestamp: Date.parse('2026-07-17T00:00:02.000Z') }])
})

test('shows concurrent evidence only for authoritatively mapped agents and sanitizes names', () => {
  const state = reduceOrchestrationSnapshot([
    event('workflow_session_registered', { sessionId: 'root-session', runtime: 'codex' }),
    event('workflow_session_registered', { sessionId: 'luna-session', runtime: 'claude' }),
    event('workflow_session_registered', { workflowId: 'workflow-2', sessionId: 'other-session', runtime: 'codex' }),
    event('agent_registered', { agentId: 'root', agentName: 'C:\\private\\Sol', sessionId: 'root-session' }),
    event('agent_registered', { agentId: 'luna', agentName: '/private/Luna', sessionId: 'luna-session' }),
    event('agent_registered', { workflowId: 'workflow-2', agentId: 'other', agentName: 'Other', sessionId: 'other-session' }),
  ])
  const activity = (id: string, workflowId: string, sessionId: string, agentId: string, artifactType: RuntimeActivityEvent['artifactType'], operation: RuntimeActivityEvent['operation'], label: string): RuntimeActivityEvent => ({
    id, runtime: artifactType === 'file' ? 'claude' : 'codex', workflowId, sessionId, agentId, timestamp: Date.parse('2026-07-17T00:00:01.000Z'),
    callId: id, operation, artifactType, artifactId: `${sessionId}:${id}`, label, phase: 'start', status: 'running',
    evidenceSource: artifactType === 'file' ? 'claude-runtime' : 'codex-rollout', authority: 'observed', confidence: 'high',
  })
  const model = buildWorkflowCanvasModel('workflow-1', state, [
    { ...session('root-session', workflow()), runtime: 'codex' },
    { ...session('luna-session', workflow()), runtime: 'claude' },
    { ...session('other-session', workflow('workflow-2')), runtime: 'codex' },
  ], [], [
    activity('read-one', 'workflow-1', 'root-session', 'root', 'file', 'read', 'Reading · src/one.ts'),
    activity('command-two', 'workflow-1', 'luna-session', 'luna', 'command', 'execute', 'Running · pnpm test'),
    activity('return-one', 'workflow-1', 'luna-session', 'luna', 'result', 'return', 'Returning control · outcome unavailable'),
    activity('leak', 'workflow-2', 'other-session', 'other', 'command', 'execute', 'Running · private command'),
  ])

  assert.equal(model.agents.get('root')?.name.startsWith('Sol'), true)
  assert.equal(model.agents.get('luna')?.name.startsWith('Luna'), true)
  assert.equal(model.discoveries.length, 2)
  assert.equal(model.discoveries.some(discovery => discovery.label.startsWith('Returning control')), true)
  assert.equal(model.toolCalls.size, 1)
  assert.equal(model.toolCalls.has('leak'), false)
  assert.equal(model.edges.some(edge => edge.id === 'artifact-edge-leak'), false)
})

test('does not fabricate missing context or elapsed telemetry', () => {
  const state = reduceOrchestrationSnapshot([
    event('agent_registered', { agentId: 'no-session' }),
    event('agent_registered', { agentId: 'no-tokens', sessionId: 'session-no-tokens' }),
    event('agent_registered', { agentId: 'known-zero', sessionId: 'session-known-zero' }),
  ])
  const noTokens = { ...session('session-no-tokens'), tokens: undefined, tokensMax: undefined }
  const knownZero = { ...session('session-known-zero'), tokens: 0, tokensMax: 200 }
  const model = buildWorkflowCanvasModel('workflow-1', state, [noTokens, knownZero], [])
  assert.equal(model.agents.get('no-session')?.contextKnown, false)
  assert.equal(model.agents.get('no-session')?.elapsedKnown, false)
  assert.equal(model.agents.get('no-session')?.tokensMax, 0)
  assert.equal(model.agents.get('no-tokens')?.contextKnown, false)
  assert.equal(model.agents.get('no-tokens')?.elapsedKnown, true)
  assert.equal(model.agents.get('known-zero')?.contextKnown, true)
  assert.equal(model.agents.get('known-zero')?.tokensUsed, 0)
  assert.equal(model.agents.get('known-zero')?.tokensMax, 200)
})

test('keeps orchestration lifecycle visuals truthful and conversation-free', () => {
  for (const [status, visual] of [['waiting', 'waiting'], ['blocked', 'blocked'], ['returned', 'returned'], ['completed', 'complete'], ['failed', 'error']] as const) {
    const state = reduceOrchestrationSnapshot([
      event('agent_registered', { agentId: 'agent', sessionId: 'session-1' }),
      event('agent_status_updated', { agentId: 'agent', status }),
    ])
    const agent = buildWorkflowCanvasModel('workflow-1', state, [session('session-1')], []).agents.get('agent')
    assert.equal(agent?.state, visual)
    assert.equal(agent?.statusLabel, status[0].toUpperCase() + status.slice(1))
    assert.deepEqual(agent?.messageBubbles, [])
  }
})

test('preserves an explicit missing parent without styling the child as root', () => {
  const state = reduceOrchestrationSnapshot([
    event('agent_registered', { agentId: 'child', sessionId: 'child-session' }),
    event('delegation_created', { agentId: 'child', parentAgentId: 'missing-parent' }),
  ])
  const child = buildWorkflowCanvasModel('workflow-1', state, [session('child-session')], []).agents.get('child')
  assert.equal(child?.parentId, null)
  assert.equal(child?.recordedParentId, 'missing-parent')
  assert.equal(child?.isMain, false)
})

test('distinguishes clicks from cumulative canvas pans', () => {
  assert.equal(isCanvasClickGesture(10, 10, 12, 11, false, 5), true)
  assert.equal(isCanvasClickGesture(10, 10, 10, 10, true, 5), false)
  assert.equal(isCanvasClickGesture(10, 10, 80, 10, false, 5), false)
})

test('fullscreen mode restores overflow and removes keyboard and frame work', () => {
  let listener: ((event: KeyboardEvent) => void) | undefined
  let cancelled = 0
  let ready = 0
  let exited = 0
  const target = {
    addEventListener: (_type: string, callback: EventListenerOrEventListenerObject) => { listener = callback as (event: KeyboardEvent) => void },
    removeEventListener: (_type: string, callback: EventListenerOrEventListenerObject) => { if (listener === callback) listener = undefined },
    requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 7 },
    cancelAnimationFrame: (id: number) => { cancelled = id },
  } as Pick<Window, 'addEventListener' | 'removeEventListener' | 'requestAnimationFrame' | 'cancelAnimationFrame'>
  const style = { overflow: 'auto' }
  const cleanup = installFullscreenMode(target, style, event => { if (event.key === 'Escape') exited++ }, () => { ready++ })
  assert.equal(style.overflow, 'hidden')
  assert.equal(ready, 1)
  listener?.({ key: 'Escape' } as KeyboardEvent)
  assert.equal(exited, 1)
  cleanup()
  assert.equal(style.overflow, 'auto')
  assert.equal(listener, undefined)
  assert.equal(cancelled, 7)
})

test('camera commands execute once even when viewport callbacks change', () => {
  assert.equal(shouldProcessCameraCommand(undefined, 3), true)
  assert.equal(shouldProcessCameraCommand(3, 3), false)
  assert.equal(shouldProcessCameraCommand(3, 4), true)
})

test('combines delayed orchestration and session activity deterministically and filters every owner field', () => {
  const state = reduceOrchestrationSnapshot([
    event('workflow_started', { eventId: 'later', timestamp: '2026-07-17T00:00:03.000Z', workflowName: 'Release' }),
    event('agent_registered', { eventId: 'agent', timestamp: '2026-07-17T00:00:01.000Z', agentId: 'agent-1', agentName: 'Builder', sessionId: 'session-1' }),
    event('assignment_started', { eventId: 'assignment', timestamp: '2026-07-17T00:00:02.000Z', agentId: 'agent-1', assignmentId: 'assignment-1', assignmentTitle: 'Build' }),
  ])
  const activities = [{ id: 1, sessionId: 'session-1', timestamp: Date.parse('2026-07-17T00:00:02.500Z'), type: 'tool_call_start', label: 'Running tests' }]
  const timeline = buildWorkflowTimeline('workflow-1', state, activities)
  assert.deepEqual(timeline.map(item => item.id), ['orchestration-agent', 'orchestration-assignment', 'session-1', 'orchestration-later'])
  assert.equal(filterWorkflowTimeline(timeline, { agentId: 'agent-1', sessionId: 'session-1', eventType: 'tool_call_start' }).length, 1)
  assert.equal(filterWorkflowTimeline(timeline, { assignmentId: 'assignment-1' })[0].id, 'orchestration-assignment')
})

test('incrementally keeps only meaningful display-safe session activity and bounds retention', () => {
  let activities = appendSessionActivity([], { time: 1, type: 'unknown', payload: {} }, 'session-1', 1)
  assert.equal(activities.length, 0)
  activities = appendSessionActivity(activities, { time: 1, type: 'agent_complete', payload: {} }, 'session-1', 1)
  assert.equal(activities.length, 0)
  for (let index = 0; index < CONTROL_ROOM_TIMELINE_LIMIT + 10; index++) {
    activities = appendSessionActivity(activities, { time: index, type: 'context_update', payload: { tokens: index } }, 'session-1', index)
  }
  assert.equal(activities.length, CONTROL_ROOM_TIMELINE_LIMIT)
  assert.equal(activities.at(-1)?.label, 'Context usage updated')
})

test('partitions session activity once by explicit membership without cross-workflow leakage', () => {
  const activities = [
    { id: 1, sessionId: 'one', timestamp: 1, type: 'message', label: 'One' },
    { id: 2, sessionId: 'two', timestamp: 2, type: 'message', label: 'Two' },
    { id: 3, sessionId: 'legacy', timestamp: 3, type: 'message', label: 'Legacy' },
  ]
  const partitioned = partitionSessionActivity(activities, new Map([['one', 'workflow-1'], ['two', 'workflow-2']]))
  assert.deepEqual(partitioned.get('workflow-1')?.map(item => item.sessionId), ['one'])
  assert.deepEqual(partitioned.get('workflow-2')?.map(item => item.sessionId), ['two'])
  assert.equal([...partitioned.values()].flat().some(item => item.sessionId === 'legacy'), false)
})

test('large timeline construction remains bounded and fast', () => {
  const events = Array.from({ length: 10_000 }, (_, index) => event('assignment_updated', {
    eventId: `volume-${index}`, assignmentId: `assignment-${index % 20}`,
    timestamp: new Date(Date.UTC(2026, 6, 17, 0, 0, 0, index)).toISOString(), status: 'active',
  }))
  const state = reduceOrchestrationSnapshot(events)
  const started = performance.now()
  const timeline = buildWorkflowTimeline('workflow-1', state, [])
  const elapsed = performance.now() - started
  assert.equal(timeline.length, CONTROL_ROOM_TIMELINE_LIMIT)
  assert.ok(CONTROL_ROOM_RENDER_LIMIT < CONTROL_ROOM_TIMELINE_LIMIT)
  assert.ok(elapsed < 500, `timeline took ${elapsed.toFixed(1)}ms`)
})

test('control room source preserves semantic labels, keyboard focus, reduced DOM volume, and detail navigation', () => {
  const source = readFileSync(new URL('../web/components/agent-visualizer/control-room.tsx', import.meta.url), 'utf8')
  for (const marker of ['Live interaction canvas', '<fieldset>', '<legend', 'focus-visible:', 'Open details', 'onOpen(item.sessionId!)', 'CONTROL_ROOM_RENDER_LIMIT', 'No sessions explicitly registered.']) assert.ok(source.includes(marker), `missing ${marker}`)
  const topologySource = readFileSync(new URL('../web/components/agent-visualizer/workflow-topology-canvas.tsx', import.meta.url), 'utf8')
  for (const marker of ['Animated live agent interaction canvas', '<AgentCanvas', 'edgeSignals={model.signals}', 'showOperationalLabels', 'selectedAgentId={selectedAgentId}', 'Close details', 'Recent commands and tools', 'privacy-safe lifecycle data', 'Fullscreen canvas', 'Fullscreen interaction mode', 'Exit fullscreen', 'Showcase', 'Live · privacy mode', 'Replay · privacy mode', 'Legend: agents', 'Pause', 'Resume', 'Restart replay', 'Replay speed', "event.key === 'Escape'", 'installFullscreenMode', 'aria-modal={fullscreen || undefined}', 'Secondary panels', 'cameraCommand={cameraCommand}']) assert.ok(topologySource.includes(marker), `missing ${marker}`)
  const canvasSource = readFileSync(new URL('../web/components/agent-visualizer/canvas.tsx', import.meta.url), 'utf8')
  assert.ok(canvasSource.includes("prefers-reduced-motion: reduce"))
  const cameraSource = readFileSync(new URL('../web/hooks/use-canvas-camera.ts', import.meta.url), 'utf8')
  for (const marker of ['const zoomBy', 'const recenter', 'forceAll', 'CAMERA.minZoom', 'CAMERA.maxZoom']) assert.ok(cameraSource.includes(marker), `missing camera behavior ${marker}`)
  assert.doesNotMatch(source, /AgentVisualizer/)
  const indexSource = readFileSync(new URL('../web/components/agent-visualizer/index.tsx', import.meta.url), 'utf8')
  assert.ok(indexSource.includes('bridge.sessions.length > 0 || bridge.orchestrationState.workflows.size > 0'))
  assert.ok(indexSource.includes('<SessionOrchestrationHeader'))
  const headerSource = readFileSync(new URL('../web/components/agent-visualizer/session-orchestration-header.tsx', import.meta.url), 'utf8')
  for (const marker of ['Selected session orchestration context', 'Agent relationship path', 'Workflow Overview', 'Parent agent', 'Child agents', 'Assignment', 'Session ID']) assert.ok(headerSource.includes(marker), `missing ${marker}`)
  assert.doesNotMatch(headerSource, /session\.label|prompt/i)
  assert.ok(indexSource.includes('bridge.sessions.some(session => session.id === id)'))
})
