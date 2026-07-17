import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRelayReplayMessages } from './relay-replay'
import type { AgentEvent, SessionInfo } from '../extension/src/protocol'
import type { OrchestrationEvent } from '../extension/src/orchestration-events'

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
