import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { NativeCodexBridge } from '../src/native-codex-bridge'
import { WorkflowIdentityReader, enrichSessionList } from '../src/workflow-identity'

const rootId = '019f7a48-16d8-7722-9fd6-ea6ebf1c084d'
const childId = '019f7a49-2bf6-73b2-bc5f-216d5710a371'
const line = (timestamp: string, type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp, type, payload })

function fixture(): NativeCodexBridge {
  const bridge = new NativeCodexBridge()
  bridge.processLines(rootId, [
    line('2026-07-19T12:00:00.000Z', 'session_meta', { id: rootId, session_id: rootId, thread_source: 'user' }),
    line('2026-07-19T12:00:01.000Z', 'event_msg', { type: 'task_started', turn_id: 'root-turn' }),
    line('2026-07-19T12:00:02.000Z', 'response_item', { type: 'function_call', name: 'spawn_agent', call_id: 'spawn-call', arguments: JSON.stringify({ task_name: '/root/luna', message: 'PRIVATE ASSIGNMENT' }) }),
    line('2026-07-19T12:00:03.000Z', 'event_msg', { type: 'sub_agent_activity', event_id: 'spawn-call', agent_thread_id: childId, agent_path: '/root/luna', kind: 'started' }),
    line('2026-07-19T12:00:04.000Z', 'response_item', { type: 'function_call', name: 'wait_agent', call_id: 'wait-call', arguments: '{}' }),
    line('2026-07-19T12:00:05.000Z', 'response_item', { type: 'function_call_output', call_id: 'wait-call', output: JSON.stringify({ message: 'PRIVATE RESULT', timed_out: false }) }),
    line('2026-07-19T12:00:10.000Z', 'response_item', { type: 'function_call', name: 'list_agents', call_id: 'list-call', arguments: '{}' }),
    line('2026-07-19T12:00:11.000Z', 'response_item', { type: 'function_call_output', call_id: 'list-call', output: JSON.stringify({ agents: [{ agent_name: '/root/luna', agent_status: { completed: 'PRIVATE FINAL' }, last_task_message: 'PRIVATE TASK' }] }) }),
  ])
  bridge.processLines(childId, [
    line('2026-07-19T12:00:02.500Z', 'session_meta', {
      id: childId, session_id: rootId, parent_thread_id: rootId, forked_from_id: rootId,
      thread_source: 'subagent', agent_path: '/root/luna', agent_nickname: 'Gauss', agent_role: null,
      source: { subagent: { thread_spawn: { parent_thread_id: rootId, agent_path: '/root/luna', agent_nickname: 'Gauss', agent_role: null, depth: 1 } } },
    }),
    line('2026-07-19T12:00:00.000Z', 'session_meta', { id: rootId, session_id: rootId, thread_source: 'user' }),
    line('2026-07-19T12:00:01.000Z', 'event_msg', { type: 'task_started', turn_id: 'inherited-root-turn' }),
    line('2026-07-19T12:00:04.000Z', 'event_msg', { type: 'task_started', turn_id: 'child-turn-1' }),
    line('2026-07-19T12:00:04.100Z', 'inter_agent_communication_metadata', { trigger_turn: true }),
    line('2026-07-19T12:00:04.200Z', 'response_item', { type: 'agent_message', author: '/root', recipient: '/root/luna', content: 'PRIVATE TASK' }),
    line('2026-07-19T12:00:06.000Z', 'event_msg', { type: 'task_complete', turn_id: 'child-turn-1', last_agent_message: 'PRIVATE FINAL' }),
    line('2026-07-19T12:00:07.000Z', 'event_msg', { type: 'task_started', turn_id: 'child-turn-2' }),
  ])
  return bridge
}

test('normalizes explicit native relationships and only authoritative lifecycle states', () => {
  const bridge = fixture()
  const events = bridge.getEvents()
  const childEvents = events.filter(event => 'agentId' in event && event.agentId === childId)

  assert.equal(events.filter(event => event.type === 'workflow_session_registered').length, 2)
  assert.ok(events.some(event => event.type === 'delegation_created' && event.agentId === childId && event.parentAgentId === rootId))
  assert.ok(events.some(event => event.type === 'assignment_created' && event.assignmentId === 'spawn-call' && event.assignmentTitle === '/root/luna'))
  assert.ok(childEvents.some(event => event.type === 'agent_status_updated' && event.status === 'active'))
  assert.ok(childEvents.some(event => event.type === 'agent_returned'))
  assert.ok(childEvents.some(event => event.type === 'agent_resumed'))
  assert.ok(childEvents.some(event => event.type === 'agent_status_updated' && event.status === 'completed'))
  assert.ok(events.some(event => event.type === 'agent_waiting' && event.agentId === rootId))
  assert.ok(events.some(event => event.type === 'agent_resumed' && event.agentId === rootId))
  assert.equal(events.some(event => event.type === 'agent_registered' && event.agentId === childId && 'agentRole' in event), false)
  assert.equal(childEvents.some(event => event.eventId.includes('inherited-root-turn')), false)
  assert.equal(events.some(event => ['assignment_started', 'assignment_completed', 'assignment_failed', 'workflow_completed'].includes(event.type)), false)
  assert.equal(JSON.stringify(events).includes('PRIVATE'), false)
  assert.equal(bridge.processLines(childId, []), false)
  assert.equal(new Set(events.map(event => event.eventId)).size, events.length)
})

test('rejects mismatched relationship metadata and wrong-recipient lifecycle handoffs', () => {
  const malformed = new NativeCodexBridge()
  malformed.processLines(childId, [line('2026-07-19T12:00:00.000Z', 'session_meta', {
    id: childId, session_id: rootId, parent_thread_id: rootId, forked_from_id: rootId,
    thread_source: 'subagent', agent_path: '/root/luna',
    source: { subagent: { thread_spawn: { parent_thread_id: '019f7a48-16d8-7722-9fd6-ea6ebf1c0999', agent_path: '/root/luna' } } },
  })])
  assert.equal(malformed.getEvents().length, 0)

  const bridge = new NativeCodexBridge()
  bridge.processLines(childId, [
    line('2026-07-19T12:00:00.000Z', 'session_meta', {
      id: childId, session_id: rootId, parent_thread_id: rootId, forked_from_id: rootId,
      thread_source: 'subagent', agent_path: '/root/luna',
      source: { subagent: { thread_spawn: { parent_thread_id: rootId, agent_path: '/root/luna' } } },
    }),
    line('2026-07-19T12:00:01.000Z', 'event_msg', { type: 'task_started', turn_id: 'inherited' }),
    line('2026-07-19T12:00:02.000Z', 'event_msg', { type: 'task_started', turn_id: 'not-luna' }),
    line('2026-07-19T12:00:02.100Z', 'inter_agent_communication_metadata', { trigger_turn: true }),
    line('2026-07-19T12:00:02.200Z', 'response_item', { type: 'agent_message', author: '/root', recipient: '/root/terra', content: 'PRIVATE' }),
    line('2026-07-19T12:00:03.000Z', 'event_msg', { type: 'task_complete', turn_id: 'not-luna' }),
  ])
  assert.equal(bridge.getEvents().some(event => ['agent_returned', 'agent_resumed', 'agent_status_updated'].includes(event.type)), false)
})

test('bounds retained native turns deterministically', () => {
  const bridge = fixture()
  const lines: string[] = []
  for (let index = 0; index < 600; index++) {
    lines.push(line(`2026-07-20T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`, 'event_msg', { type: 'task_started', turn_id: `bounded-${index}` }))
  }
  bridge.processLines(childId, lines)
  assert.ok(bridge.getEvents().filter(event => event.eventId.includes(':turn:bounded-')).length <= 512)
})

test('supplemental native events group real Codex sessions without a manual sidecar', () => {
  const bridge = fixture()
  const reader = new WorkflowIdentityReader(path.join(os.tmpdir(), `missing-agent-flow-${process.pid}.jsonl`))
  assert.equal(reader.setSupplementalEvents(bridge.getEvents()), true)
  const [session] = enrichSessionList(reader, [{ id: childId, runtime: 'codex' as const }])
  assert.equal(session.workflow?.workflowId, rootId)
  assert.equal(reader.getOrchestrationEvents().length, bridge.getEvents().length)
})
