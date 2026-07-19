import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { performance } from 'node:perf_hooks'
import { ORCHESTRATION_EVENT_TYPES, parseOrchestrationEvent, selectOrchestrationUpdate } from '../extension/src/orchestration-events'
import { WorkflowIdentityReader } from '../extension/src/workflow-identity'
import { createOrchestrationState, MAX_ORCHESTRATION_EVENTS, MAX_ORCHESTRATION_TIMELINE_EVENTS, orchestrationEntityKey, reduceOrchestrationEvent, reduceOrchestrationSnapshot } from '../web/lib/orchestration-state'
import type { OrchestrationEvent } from '../web/lib/bridge-types'

const base = (type: string, overrides: Record<string, unknown> = {}) => ({
  eventId: `event-${type}`, eventVersion: 1, type, timestamp: '2026-07-17T00:00:00.000Z',
  workflowId: 'workflow-1', source: 'local launcher', ...overrides,
})

const validByType: Record<string, Record<string, unknown>> = {
  workflow_session_registered: { workflowName: 'Release', workflowCreatedAt: '2026-07-16T23:00:00.000Z', workflowSource: 'launcher', sessionId: 'session-1', runtime: 'codex' },
  workflow_started: { workflowName: 'Release' },
  workflow_updated: { status: 'active' },
  workflow_completed: {},
  agent_registered: { agentId: 'agent-1', agentName: 'Builder' },
  assignment_created: { assignmentId: 'assignment-1', assignmentTitle: 'Implement parser' },
  assignment_started: { assignmentId: 'assignment-1', agentId: 'agent-1' },
  assignment_updated: { assignmentId: 'assignment-1', agentId: 'agent-2' },
  assignment_blocked: { assignmentId: 'assignment-1', reason: 'Waiting for review' },
  assignment_completed: { assignmentId: 'assignment-1' },
  assignment_failed: { assignmentId: 'assignment-1', reason: 'Tests failed' },
  delegation_created: { agentId: 'agent-2', parentAgentId: 'agent-1' },
  dependency_created: { assignmentId: 'assignment-2', dependencyIds: ['assignment-1'] },
  agent_waiting: { agentId: 'agent-1' },
  agent_resumed: { agentId: 'agent-1' },
  agent_returned: { agentId: 'agent-1' },
  orchestration_message: { agentId: 'agent-1', reason: 'Review requested' },
}

test('parses every version-1 event type and strips unknown fields', () => {
  for (const type of ORCHESTRATION_EVENT_TYPES) {
    const parsed = parseOrchestrationEvent(base(type, { ...validByType[type], ignored: 'not transported' }))
    assert.equal(parsed?.type, type)
    assert.equal('ignored' in (parsed ?? {}), false)
  }
})

test('rejects unsupported, malformed, cyclic-self, and private raw content', () => {
  assert.equal(parseOrchestrationEvent(base('agent_registered', { ...validByType.agent_registered, eventVersion: 2 })), null)
  assert.equal(parseOrchestrationEvent(base('unknown', {})), null)
  assert.equal(parseOrchestrationEvent(base('agent_registered', { agentId: 'agent-1' })), null)
  assert.equal(parseOrchestrationEvent(base('delegation_created', { agentId: 'agent-1', parentAgentId: 'agent-1' })), null)
  assert.equal(parseOrchestrationEvent(base('agent_registered', { ...validByType.agent_registered, transcript: 'private' })), null)
  assert.equal(parseOrchestrationEvent(base('agent_registered', { ...validByType.agent_registered, metadata: { secret: 'private' } })), null)
  assert.equal(parseOrchestrationEvent(base('agent_registered', { ...validByType.agent_registered, password: 'private' })), null)
  assert.equal(parseOrchestrationEvent(base('agent_registered', { ...validByType.agent_registered, apiKey: 'private' })), null)
  assert.equal(parseOrchestrationEvent(base('agent_registered', { ...validByType.agent_registered, authorization: 'private' })), null)
  assert.equal(parseOrchestrationEvent(base('agent_registered', { ...validByType.agent_registered, cookie: 'private' })), null)
  assert.equal(parseOrchestrationEvent(base('agent_registered', { ...validByType.agent_registered, metadata: { unknown: true } })), null)
  for (const type of ORCHESTRATION_EVENT_TYPES.filter(type => type.startsWith('workflow_') || type.startsWith('assignment_'))) {
    assert.equal(parseOrchestrationEvent(base(type, { ...validByType[type], status: 'returned' })), null, type)
  }
  assert.equal(parseOrchestrationEvent(base('agent_returned', validByType.agent_returned))?.type, 'agent_returned')
  assert.equal(parseOrchestrationEvent(base('workflow_updated', { status: 'failed' }))?.status, 'failed')
  assert.deepEqual(parseOrchestrationEvent(base('agent_registered', { ...validByType.agent_registered,
    metadata: { attempt: 2, priority: 'high', progressPercent: 50, retryable: true } }))?.metadata,
  { attempt: 2, priority: 'high', progressPercent: 50, retryable: true })
})

test('reader replays and tails one bounded idempotent orchestration stream', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-flow-orchestration-'))
  const file = join(dir, 'orchestration.jsonl')
  const registered = base('agent_registered', validByType.agent_registered)
  try {
    writeFileSync(file, `${JSON.stringify(registered)}\n${JSON.stringify(registered)}\n`)
    const live = new WorkflowIdentityReader(file)
    assert.equal(live.refresh(), true)
    assert.deepEqual(live.getOrchestrationEvents().map(event => event.eventId), ['event-agent_registered'])

    appendFileSync(file, `${JSON.stringify(base('agent_waiting', validByType.agent_waiting))}\n`)
    assert.equal(live.refresh(), true)
    assert.equal(live.getOrchestrationEvents().length, 2)

    const replay = new WorkflowIdentityReader(file)
    replay.refresh()
    assert.deepEqual(replay.getOrchestrationEvents(), live.getOrchestrationEvents())

    writeFileSync(file, '')
    assert.equal(live.refresh(), true)
    assert.deepEqual(live.getOrchestrationEvents(), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

let eventNumber = 0
const event = (type: OrchestrationEvent['type'], overrides: Partial<OrchestrationEvent> = {}): OrchestrationEvent => ({
  eventId: `${type}-${eventNumber++}`, eventVersion: 1, type, timestamp: '2026-07-17T00:00:00.000Z',
  workflowId: 'workflow-1', source: 'launcher', ...overrides,
})

test('incremental state is idempotent, ordered, explicit, and supports reassignment and lifecycle', () => {
  const events = [
    event('agent_waiting', { eventId: 'wait', agentId: 'agent-1', assignmentId: 'assignment-1', timestamp: '2026-07-17T00:00:03.000Z' }),
    event('assignment_started', { eventId: 'start', assignmentId: 'assignment-1', agentId: 'agent-1', timestamp: '2026-07-17T00:00:01.000Z' }),
    event('agent_registered', { eventId: 'register', agentId: 'agent-1', agentName: 'Builder', agentRole: 'Implementation' }),
    event('assignment_created', { eventId: 'create', assignmentId: 'assignment-1', assignmentTitle: 'Build contract', timestamp: '2026-07-17T00:00:00.500Z' }),
    event('assignment_updated', { eventId: 'reassign', assignmentId: 'assignment-1', agentId: 'agent-2', timestamp: '2026-07-17T00:00:02.000Z' }),
    event('assignment_blocked', { eventId: 'blocked', assignmentId: 'assignment-1', reason: 'Dependency', timestamp: '2026-07-17T00:00:03.000Z' }),
    event('assignment_completed', { eventId: 'completed', assignmentId: 'assignment-1', timestamp: '2026-07-17T00:00:04.000Z' }),
    event('agent_resumed', { eventId: 'resume', agentId: 'agent-1', timestamp: '2026-07-17T00:00:04.000Z' }),
    event('agent_returned', { eventId: 'return', agentId: 'agent-1', timestamp: '2026-07-17T00:00:05.000Z' }),
  ]
  const state = reduceOrchestrationSnapshot([...events, events[0]])
  const agentKey = orchestrationEntityKey('workflow-1', 'agent-1')
  const assignmentKey = orchestrationEntityKey('workflow-1', 'assignment-1')
  assert.equal(state.events.length, events.length)
  assert.ok(state.events.findIndex(item => item.event.eventId === 'start') < state.events.findIndex(item => item.event.eventId === 'wait'))
  assert.equal(state.agents.get(agentKey)?.agentName, 'Builder')
  assert.equal(state.agents.get(agentKey)?.status, 'returned')
  assert.equal(state.assignments.get(assignmentKey)?.agentId, 'agent-2')
  assert.equal(state.assignments.get(assignmentKey)?.status, 'completed')
  assert.equal(state.assignments.get(assignmentKey)?.reason, undefined)
})

test('missing parents remain unresolved while delegation and dependency cycles are rejected', () => {
  const state = reduceOrchestrationSnapshot([
    event('delegation_created', { eventId: 'missing-parent', agentId: 'child', parentAgentId: 'missing' }),
    event('delegation_created', { eventId: 'parent', agentId: 'parent', parentAgentId: 'child' }),
    event('delegation_created', { eventId: 'cycle', agentId: 'missing', parentAgentId: 'parent' }),
    event('dependency_created', { eventId: 'dep-a', assignmentId: 'a', dependencyIds: ['b'] }),
    event('dependency_created', { eventId: 'dep-b', assignmentId: 'b', dependencyIds: ['a'] }),
  ])
  assert.equal(state.delegations.get(orchestrationEntityKey('workflow-1', 'child'))?.parentAgentId, 'missing')
  assert.equal(state.delegations.get(orchestrationEntityKey('workflow-1', 'parent'))?.parentAgentId, 'child')
  assert.equal(state.delegations.has(orchestrationEntityKey('workflow-1', 'missing')), false)
  assert.deepEqual(state.assignments.get(orchestrationEntityKey('workflow-1', 'a'))?.dependencyIds, ['b'])
  assert.deepEqual(state.assignments.get(orchestrationEntityKey('workflow-1', 'b'))?.dependencyIds, [])
})

test('legacy sessions and names never create workflow, agent, or relationship state', () => {
  const empty = createOrchestrationState()
  assert.equal(empty.workflows.size, 0)
  assert.equal(empty.memberships.size, 0)
  assert.equal(empty.delegations.size, 0)
  const messageOnly = reduceOrchestrationEvent(empty, event('orchestration_message', { eventId: 'message', sessionId: 'legacy', reason: 'Observed' }))
  assert.equal(messageOnly.memberships.size, 0)
  assert.equal(messageOnly.agents.size, 0)
})

test('equal agent and assignment IDs remain isolated across workflows', () => {
  const state = reduceOrchestrationSnapshot([
    event('agent_registered', { eventId: 'agent-one', workflowId: 'workflow-1', agentId: 'agent', agentName: 'One' }),
    event('agent_registered', { eventId: 'agent-two', workflowId: 'workflow-2', agentId: 'agent', agentName: 'Two' }),
    event('assignment_created', { eventId: 'assignment-one', workflowId: 'workflow-1', assignmentId: 'assignment', assignmentTitle: 'One' }),
    event('assignment_created', { eventId: 'assignment-two', workflowId: 'workflow-2', assignmentId: 'assignment', assignmentTitle: 'Two' }),
  ])
  assert.equal(state.agents.get(orchestrationEntityKey('workflow-1', 'agent'))?.agentName, 'One')
  assert.equal(state.agents.get(orchestrationEntityKey('workflow-2', 'agent'))?.agentName, 'Two')
  assert.equal(state.assignments.get(orchestrationEntityKey('workflow-1', 'assignment'))?.assignmentTitle, 'One')
  assert.equal(state.assignments.get(orchestrationEntityKey('workflow-2', 'assignment'))?.assignmentTitle, 'Two')
})

test('delayed older events cannot regress workflow, agent, assignment, or reassignment state', () => {
  const older = '2026-07-17T00:00:01.000Z'
  const newer = '2026-07-17T00:00:02.000Z'
  const state = reduceOrchestrationSnapshot([
    event('workflow_completed', { eventId: 'workflow-new', timestamp: newer }),
    event('agent_returned', { eventId: 'agent-new', timestamp: newer, agentId: 'agent' }),
    event('assignment_completed', { eventId: 'assignment-new', timestamp: newer, assignmentId: 'assignment' }),
    event('assignment_updated', { eventId: 'owner-new', timestamp: newer, assignmentId: 'owned', agentId: 'agent-2' }),
  ])
  const delayed = [
    event('workflow_started', { eventId: 'workflow-old', timestamp: older, workflowName: 'Release' }),
    event('agent_waiting', { eventId: 'agent-old', timestamp: older, agentId: 'agent' }),
    event('assignment_started', { eventId: 'assignment-old', timestamp: older, assignmentId: 'assignment', agentId: 'agent' }),
    event('assignment_updated', { eventId: 'owner-old', timestamp: older, assignmentId: 'owned', agentId: 'agent-1' }),
  ].reduce(reduceOrchestrationEvent, state)
  assert.equal(delayed.workflows.get('workflow-1')?.status, 'completed')
  assert.equal(delayed.agents.get(orchestrationEntityKey('workflow-1', 'agent'))?.status, 'returned')
  assert.equal(delayed.assignments.get(orchestrationEntityKey('workflow-1', 'assignment'))?.status, 'completed')
  assert.equal(delayed.assignments.get(orchestrationEntityKey('workflow-1', 'owned'))?.agentId, 'agent-2')
})

test('equal timestamps preserve ingestion order', () => {
  const timestamp = '2026-07-17T00:00:00.000Z'
  const state = reduceOrchestrationSnapshot([
    event('assignment_updated', { eventId: 'first-owner', timestamp, assignmentId: 'assignment', agentId: 'agent-1' }),
    event('assignment_updated', { eventId: 'second-owner', timestamp, assignmentId: 'assignment', agentId: 'agent-2' }),
  ])
  assert.equal(state.assignments.get(orchestrationEntityKey('workflow-1', 'assignment'))?.agentId, 'agent-2')
})

test('shared update selector handles initial, append, truncation, and replacement', () => {
  const first = event('workflow_started', { eventId: 'first', timestamp: '2026-07-17T00:00:01.000Z', workflowName: 'Release' })
  const second = event('assignment_created', { eventId: 'second', timestamp: '2026-07-17T00:00:02.000Z', assignmentId: 'assignment', assignmentTitle: 'Build' })
  assert.equal(selectOrchestrationUpdate(undefined, [first]).type, 'orchestration-snapshot')
  assert.deepEqual(selectOrchestrationUpdate(['first'], [first, second]), { type: 'orchestration-event-batch', events: [second] })
  assert.equal(selectOrchestrationUpdate(['first', 'second'], [first]).type, 'orchestration-snapshot')
  assert.equal(selectOrchestrationUpdate(['first', 'second'], [second, first]).type, 'orchestration-snapshot')

  const live = reduceOrchestrationEvent(reduceOrchestrationSnapshot([first]), second)
  const replacementMessage = selectOrchestrationUpdate(['first', 'second'], [second, first])
  assert.equal(replacementMessage.type, 'orchestration-snapshot')
  const replacement = reduceOrchestrationSnapshot(replacementMessage.events)
  assert.deepEqual([...replacement.workflows], [...live.workflows])
  assert.deepEqual([...replacement.assignments], [...live.assignments])
})

test('reduces 10,000-event snapshots within a generous performance ceiling', () => {
  const events = Array.from({ length: 10_000 }, (_, index) => event('workflow_updated', {
    eventId: `performance-${index}`, timestamp: new Date(Date.UTC(2026, 6, 17, 0, 0, 0, index)).toISOString(), status: 'active',
  }))
  const started = performance.now()
  const state = reduceOrchestrationSnapshot(events)
  const elapsed = performance.now() - started
  console.log(`10k orchestration snapshot: ${elapsed.toFixed(1)}ms`)
  assert.equal(state.acceptedEvents.length, MAX_ORCHESTRATION_EVENTS)
  assert.equal(state.eventIds.size, MAX_ORCHESTRATION_EVENTS)
  assert.equal(state.events.length, MAX_ORCHESTRATION_TIMELINE_EVENTS)
  assert.equal(state.eventsByWorkflow.get('workflow-1')?.length, MAX_ORCHESTRATION_TIMELINE_EVENTS)
  assert.ok(elapsed < 1_000, `10k snapshot took ${elapsed.toFixed(1)}ms`)
})

test('bounds sustained multi-workflow state, ignores overflow, and reconstructs indexed replay', () => {
  const events = Array.from({ length: MAX_ORCHESTRATION_EVENTS + 500 }, (_, index) => event('workflow_updated', {
    eventId: `bounded-${index}`, workflowId: `workflow-${index % 2 + 1}`,
    timestamp: new Date(Date.UTC(2026, 6, 17, 0, 0, 0, index)).toISOString(), status: 'active',
  }))
  const first = reduceOrchestrationSnapshot(events)
  const reconnect = reduceOrchestrationSnapshot(events)
  assert.equal(first.acceptedEvents.length, MAX_ORCHESTRATION_EVENTS)
  assert.equal(first.events.length, MAX_ORCHESTRATION_TIMELINE_EVENTS)
  assert.equal([...first.eventsByWorkflow.values()].reduce((sum, items) => sum + items.length, 0), MAX_ORCHESTRATION_TIMELINE_EVENTS)
  assert.deepEqual([...reconnect.eventsByWorkflow].map(([id, items]) => [id, items.map(item => item.event.eventId)]),
    [...first.eventsByWorkflow].map(([id, items]) => [id, items.map(item => item.event.eventId)]))
  assert.strictEqual(reduceOrchestrationEvent(first, events.at(-1)!), first)
})

test('delayed events rebuild current entities and workflow timeline indexes', () => {
  const state = reduceOrchestrationSnapshot([
    event('workflow_started', { eventId: 'newer-w1', workflowId: 'workflow-1', timestamp: '2026-07-17T00:00:02.000Z' }),
    event('workflow_started', { eventId: 'newer-w2', workflowId: 'workflow-2', timestamp: '2026-07-17T00:00:03.000Z' }),
  ])
  const delayed = reduceOrchestrationEvent(state, event('assignment_created', { eventId: 'older-w1', workflowId: 'workflow-1', assignmentId: 'assignment', timestamp: '2026-07-17T00:00:01.000Z' }))
  assert.deepEqual(delayed.eventsByWorkflow.get('workflow-1')?.map(item => item.event.eventId), ['older-w1', 'newer-w1'])
  assert.deepEqual(delayed.eventsByWorkflow.get('workflow-2')?.map(item => item.event.eventId), ['newer-w2'])
  assert.equal(delayed.assignments.has(orchestrationEntityKey('workflow-1', 'assignment')), true)
})
