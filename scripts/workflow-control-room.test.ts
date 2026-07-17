import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { performance } from 'node:perf_hooks'
import { reduceOrchestrationSnapshot } from '../web/lib/orchestration-state'
import type { OrchestrationEvent, WorkflowIdentity } from '../web/lib/bridge-types'
import type { SessionSummary } from '../web/lib/session-summary'
import {
  appendSessionActivity, buildAgentForest, buildWorkflowTimeline, CONTROL_ROOM_RENDER_LIMIT,
  CONTROL_ROOM_TIMELINE_LIMIT, filterWorkflowTimeline, partitionSessionActivity, workflowMetrics, workflowStatus,
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
  for (const marker of ['aria-label="Authoritative agent relationships"', '<fieldset>', '<legend', 'focus-visible:', 'Open details', 'onOpen(item.sessionId!)', 'CONTROL_ROOM_RENDER_LIMIT', 'No sessions explicitly registered.']) assert.ok(source.includes(marker), `missing ${marker}`)
  assert.doesNotMatch(source, /AgentVisualizer/)
  const indexSource = readFileSync(new URL('../web/components/agent-visualizer/index.tsx', import.meta.url), 'utf8')
  assert.ok(indexSource.includes('bridge.sessions.length > 0 || bridge.orchestrationState.workflows.size > 0'))
})
