import type { AgentEvent, SessionInfo } from '../extension/src/protocol'
import { selectOrchestrationUpdate, type OrchestrationEvent } from '../extension/src/orchestration-events'

export function buildRelayReplayMessages(orchestrationEvents: readonly OrchestrationEvent[], sessionList: readonly SessionInfo[], buffers: ReadonlyMap<string, AgentEvent[]>): unknown[] {
  const messages: unknown[] = [
    { type: 'reset', reason: 'relay-reconnect' },
    selectOrchestrationUpdate(undefined, orchestrationEvents),
    { type: 'session-list', sessions: sessionList },
  ]
  const sorted = [...sessionList].sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || b.lastActivityTime - a.lastActivityTime)
  for (const session of sorted) {
    const events = buffers.get(session.id)
    if (events) messages.push({ type: 'agent-event-batch', events })
  }
  return messages
}
