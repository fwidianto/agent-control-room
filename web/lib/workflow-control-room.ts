import type { AgentEvent, OrchestrationEventType, OrchestrationStatus } from './bridge-types'
import type { AgentOrchestrationState, OrchestrationState } from './orchestration-state'
import { orchestrationEntityKey } from './orchestration-state'
import { interpretActivity, sessionStatus, type SessionSummary } from './session-summary'

export const CONTROL_ROOM_TIMELINE_LIMIT = 5_000
export const CONTROL_ROOM_RENDER_LIMIT = 200

export type ControlRoomStatus = 'Active' | 'Waiting' | 'Blocked' | 'Inactive' | 'Completed' | 'Failed' | 'Unknown'

export interface SessionActivityEvent {
  id: number
  sessionId: string
  timestamp: number
  type: string
  label: string
}

export interface WorkflowTimelineItem {
  id: string
  timestamp: number
  eventType: string
  label: string
  source: string
  sessionId?: string
  agentId?: string
  agentName?: string
  assignmentId?: string
}

export interface TimelineFilters {
  agentId?: string
  sessionId?: string
  assignmentId?: string
  eventType?: string
}

export interface AgentTreeNode {
  agent: AgentOrchestrationState
  children: AgentTreeNode[]
}

export interface WorkflowStateCounts {
  agents: Record<'Active' | 'Waiting' | 'Blocked' | 'Returned' | 'Completed' | 'Failed' | 'Unknown', number>
  assignments: Record<'Active' | 'Waiting' | 'Blocked' | 'Completed' | 'Failed' | 'Unknown', number>
  sessions: Record<'Active' | 'Waiting' | 'Inactive', number>
}

function title(value: string): string {
  return value.split('_').map(word => word[0]?.toUpperCase() + word.slice(1)).join(' ')
}

function orchestrationLabel(type: OrchestrationEventType, event: { assignmentTitle?: string; agentName?: string; reason?: string }): string {
  const subject = event.assignmentTitle ?? event.agentName
  return `${title(type)}${subject ? `: ${subject}` : ''}${event.reason ? ` — ${event.reason}` : ''}`
}

export function appendSessionActivity(current: SessionActivityEvent[], event: AgentEvent, sessionId: string, timestamp: number): SessionActivityEvent[] {
  if (event.type === 'agent_complete') return current
  const label = event.type === 'context_update' ? 'Context usage updated'
    : interpretActivity(event)
  if (!label) return current
  const next = [...current, { id: current.length ? current[current.length - 1].id + 1 : 0, sessionId, timestamp, type: event.type, label }]
  return next.length > CONTROL_ROOM_TIMELINE_LIMIT ? next.slice(-CONTROL_ROOM_TIMELINE_LIMIT) : next
}

export function appendSessionLifecycle(current: SessionActivityEvent[], sessionId: string, timestamp: number, type: 'session_started' | 'session_inactive'): SessionActivityEvent[] {
  const next = [...current, { id: current.length ? current[current.length - 1].id + 1 : 0, sessionId, timestamp, type, label: type === 'session_started' ? 'Session started' : 'Session became inactive' }]
  return next.length > CONTROL_ROOM_TIMELINE_LIMIT ? next.slice(-CONTROL_ROOM_TIMELINE_LIMIT) : next
}

export function partitionSessionActivity(activities: readonly SessionActivityEvent[], memberships: ReadonlyMap<string, string>): Map<string, SessionActivityEvent[]> {
  const partitioned = new Map<string, SessionActivityEvent[]>()
  for (const item of activities) {
    const workflowId = memberships.get(item.sessionId)
    if (!workflowId) continue
    const items = partitioned.get(workflowId)
    if (items) items.push(item)
    else partitioned.set(workflowId, [item])
  }
  return partitioned
}

function explicitAgentForSession(state: OrchestrationState, workflowId: string, sessionId: string): AgentOrchestrationState | undefined {
  for (const agent of state.agents.values()) if (agent.workflowId === workflowId && agent.sessionId === sessionId) return agent
}

export function buildWorkflowTimeline(workflowId: string, state: OrchestrationState, activities: readonly SessionActivityEvent[]): WorkflowTimelineItem[] {
  const items: WorkflowTimelineItem[] = (state.eventsByWorkflow.get(workflowId) ?? [])
    .map(({ event, ingestionIndex }) => ({
      id: `orchestration-${event.eventId}`,
      timestamp: Date.parse(event.timestamp),
      eventType: event.type,
      label: orchestrationLabel(event.type, event),
      source: event.source,
      sessionId: event.sessionId,
      agentId: event.agentId,
      agentName: event.agentName ?? (event.agentId ? state.agents.get(orchestrationEntityKey(workflowId, event.agentId))?.agentName : undefined),
      assignmentId: event.assignmentId,
      _order: ingestionIndex,
    }))

  for (const activity of activities) {
    const agent = explicitAgentForSession(state, workflowId, activity.sessionId)
    items.push({ id: `session-${activity.id}`, timestamp: activity.timestamp, eventType: activity.type,
      label: activity.label, source: 'Session activity', sessionId: activity.sessionId,
      agentId: agent?.agentId, agentName: agent?.agentName, _order: activity.id } as WorkflowTimelineItem & { _order: number })
  }

  return (items as Array<WorkflowTimelineItem & { _order?: number }>).sort((a, b) => a.timestamp - b.timestamp
    || (a._order ?? 0) - (b._order ?? 0) || a.id.localeCompare(b.id)).slice(-CONTROL_ROOM_TIMELINE_LIMIT)
    .map(({ _order: _ignored, ...item }) => item)
}

export function filterWorkflowTimeline(items: readonly WorkflowTimelineItem[], filters: TimelineFilters): WorkflowTimelineItem[] {
  return items.filter(item => (!filters.agentId || item.agentId === filters.agentId)
    && (!filters.sessionId || item.sessionId === filters.sessionId)
    && (!filters.assignmentId || item.assignmentId === filters.assignmentId)
    && (!filters.eventType || item.eventType === filters.eventType))
}

function displayStatus(status?: OrchestrationStatus): ControlRoomStatus | undefined {
  if (!status || status === 'returned') return undefined
  return title(status) as ControlRoomStatus
}

export function workflowStatus(workflowId: string, state: OrchestrationState, sessions: readonly SessionSummary[]): ControlRoomStatus {
  const explicit = displayStatus(state.workflows.get(workflowId)?.status)
  if (explicit === 'Completed' || explicit === 'Failed' || explicit === 'Blocked' || explicit === 'Waiting') return explicit
  const assignments = [...state.assignments.values()].filter(item => item.workflowId === workflowId)
  const agents = [...state.agents.values()].filter(item => item.workflowId === workflowId)
  if (assignments.some(item => item.status === 'failed') || agents.some(item => item.status === 'failed')) return 'Failed'
  if (assignments.some(item => item.status === 'blocked') || agents.some(item => item.status === 'blocked')) return 'Blocked'
  if (explicit === 'Active' || assignments.some(item => item.status === 'active') || agents.some(item => item.status === 'active')
    || sessions.some(session => sessionStatus(session) === 'Active')) return 'Active'
  if (assignments.some(item => item.status === 'waiting') || agents.some(item => item.status === 'waiting')) return 'Waiting'
  if (sessions.some(session => sessionStatus(session) === 'Waiting')) return 'Waiting'
  if (sessions.length > 0 && sessions.every(session => sessionStatus(session) === 'Inactive')) return 'Inactive'
  return 'Unknown'
}

export function buildAgentForest(workflowId: string, state: OrchestrationState): { roots: AgentTreeNode[]; hierarchical: boolean } {
  const agents = [...state.agents.values()].filter(agent => agent.workflowId === workflowId)
  const nodes = new Map(agents.map(agent => [agent.agentId, { agent, children: [] as AgentTreeNode[] }]))
  let hierarchical = false
  const childIds = new Set<string>()
  for (const delegation of state.delegations.values()) {
    if (delegation.workflowId !== workflowId) continue
    const child = nodes.get(delegation.agentId)
    const parent = nodes.get(delegation.parentAgentId)
    if (!child || !parent) continue
    parent.children.push(child)
    childIds.add(child.agent.agentId)
    hierarchical = true
  }
  return { roots: agents.filter(agent => !childIds.has(agent.agentId)).map(agent => nodes.get(agent.agentId)!), hierarchical }
}

export function workflowMetrics(workflowId: string, state: OrchestrationState, sessions: readonly SessionSummary[], now: number) {
  const assignments = [...state.assignments.values()].filter(item => item.workflowId === workflowId)
  const agents = [...state.agents.values()].filter(item => item.workflowId === workflowId)
  const createdAt = sessions.map(session => session.workflow?.workflowCreatedAt).filter(Boolean).map(value => Date.parse(value!)).filter(Number.isFinite)
  const workflow = state.workflows.get(workflowId)
  const explicitStart = workflow?.startedAt ? Date.parse(workflow.startedAt) : Infinity
  const start = createdAt.length ? Math.min(...createdAt) : explicitStart
  const end = workflow?.endedAt ? Date.parse(workflow.endedAt) : now
  const tokens = sessions.reduce((sum, session) => sum + (session.tokens ?? 0), 0)
  const contextKnown = sessions.some(session => session.tokens !== undefined)
  const counts: WorkflowStateCounts = {
    agents: { Active: 0, Waiting: 0, Blocked: 0, Returned: 0, Completed: 0, Failed: 0, Unknown: 0 },
    assignments: { Active: 0, Waiting: 0, Blocked: 0, Completed: 0, Failed: 0, Unknown: 0 },
    sessions: { Active: 0, Waiting: 0, Inactive: 0 },
  }
  for (const agent of agents) {
    const status = agent.status ? title(agent.status) : 'Unknown'
    if (status in counts.agents) counts.agents[status as keyof typeof counts.agents]++
    else counts.agents.Unknown++
  }
  for (const assignment of assignments) {
    const status = assignment.status ? title(assignment.status) : 'Unknown'
    if (status in counts.assignments) counts.assignments[status as keyof typeof counts.assignments]++
    else counts.assignments.Unknown++
  }
  for (const session of sessions) counts.sessions[sessionStatus(session)]++
  return {
    status: workflowStatus(workflowId, state, sessions),
    elapsedSeconds: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.floor((end - start) / 1000)) : undefined,
    sessionCount: sessions.length,
    agentCount: agents.length,
    tokens: contextKnown ? tokens : undefined,
    assignmentCount: assignments.length,
    completedAssignments: assignments.filter(item => item.status === 'completed').length,
    counts,
  }
}
