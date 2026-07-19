import type { OrchestrationEvent, OrchestrationStatus } from './bridge-types'

export interface WorkflowOrchestrationState {
  workflowId: string
  workflowName?: string
  workflowDescription?: string
  status?: OrchestrationStatus
  source: string
  startedAt?: string
  endedAt?: string
}

export interface AgentOrchestrationState {
  agentId: string
  workflowId: string
  agentName?: string
  agentRole?: string
  sessionId?: string
  assignmentId?: string
  status?: OrchestrationStatus
  reason?: string
}

export interface AssignmentOrchestrationState {
  assignmentId: string
  workflowId: string
  assignmentTitle?: string
  assignmentDescription?: string
  agentId?: string
  dependencyIds: string[]
  status?: OrchestrationStatus
  reason?: string
  progressPercent?: number
}

export interface DelegationState {
  workflowId: string
  agentId: string
  parentAgentId: string
  sessionId?: string
  parentSessionId?: string
  assignmentId?: string
}

export interface OrderedOrchestrationEvent {
  event: OrchestrationEvent
  ingestionIndex: number
}

export interface OrchestrationState {
  workflows: Map<string, WorkflowOrchestrationState>
  memberships: Map<string, { workflowId: string; runtime: 'codex' | 'claude' }>
  agents: Map<string, AgentOrchestrationState>
  assignments: Map<string, AssignmentOrchestrationState>
  delegations: Map<string, DelegationState>
  events: OrderedOrchestrationEvent[]
  eventsByWorkflow: Map<string, OrderedOrchestrationEvent[]>
  acceptedEvents: OrderedOrchestrationEvent[]
  eventIds: Set<string>
  nextIngestionIndex: number
  latestTimestamp: number
}

export const MAX_ORCHESTRATION_EVENTS = 10_000
export const MAX_ORCHESTRATION_TIMELINE_EVENTS = 5_000

export function createOrchestrationState(): OrchestrationState {
  return {
    workflows: new Map(), memberships: new Map(), agents: new Map(), assignments: new Map(),
    delegations: new Map(), events: [], eventsByWorkflow: new Map(), acceptedEvents: [],
    eventIds: new Set(), nextIngestionIndex: 0, latestTimestamp: -Infinity,
  }
}

export function orchestrationEntityKey(workflowId: string, entityId: string): string {
  return `${workflowId}\u0000${entityId}`
}

function createsDelegationCycle(workflowId: string, agentId: string, parentAgentId: string, delegations: Map<string, DelegationState>): boolean {
  const seen = new Set([agentId])
  let current: string | undefined = parentAgentId
  while (current) {
    if (seen.has(current)) return true
    seen.add(current)
    current = delegations.get(orchestrationEntityKey(workflowId, current))?.parentAgentId
  }
  return false
}

function reachesAssignment(workflowId: string, start: string, target: string, assignments: Map<string, AssignmentOrchestrationState>, seen = new Set<string>()): boolean {
  if (start === target) return true
  if (seen.has(start)) return false
  seen.add(start)
  return (assignments.get(orchestrationEntityKey(workflowId, start))?.dependencyIds ?? [])
    .some(dependency => reachesAssignment(workflowId, dependency, target, assignments, seen))
}

function safeDependencies(workflowId: string, assignmentId: string, dependencies: string[], assignments: Map<string, AssignmentOrchestrationState>): string[] | undefined {
  return dependencies.some(dependency => dependency === assignmentId || reachesAssignment(workflowId, dependency, assignmentId, assignments))
    ? undefined : dependencies
}

function compareEvents(a: OrderedOrchestrationEvent, b: OrderedOrchestrationEvent): number {
  return Date.parse(a.event.timestamp) - Date.parse(b.event.timestamp)
    || a.ingestionIndex - b.ingestionIndex || a.event.eventId.localeCompare(b.event.eventId)
}

function applyEventMutable(next: OrchestrationState, event: OrchestrationEvent): void {
  const workflow = next.workflows.get(event.workflowId) ?? { workflowId: event.workflowId, source: event.source }

  switch (event.type) {
    case 'workflow_session_registered':
      if (event.sessionId && event.runtime) {
        next.memberships.set(event.sessionId, { workflowId: event.workflowId, runtime: event.runtime })
        next.workflows.set(event.workflowId, { ...workflow,
          ...(event.workflowName ? { workflowName: event.workflowName } : {}),
          ...(event.workflowDescription ? { workflowDescription: event.workflowDescription } : {}) })
      }
      break
    case 'workflow_started':
    case 'workflow_updated':
      next.workflows.set(event.workflowId, { ...workflow, ...(event.workflowName ? { workflowName: event.workflowName } : {}),
        ...(event.workflowDescription ? { workflowDescription: event.workflowDescription } : {}),
        ...(event.type === 'workflow_started' ? { startedAt: event.timestamp, endedAt: undefined } : {}),
        ...(event.status === 'completed' || event.status === 'failed' ? { endedAt: event.timestamp } : {}),
        status: event.status ?? (event.type === 'workflow_started' ? 'active' : workflow.status) })
      break
    case 'workflow_completed':
      next.workflows.set(event.workflowId, { ...workflow, status: 'completed', endedAt: event.timestamp })
      break
    case 'agent_registered':
      if (event.agentId) {
        const key = orchestrationEntityKey(event.workflowId, event.agentId)
        next.agents.set(key, { ...next.agents.get(key), agentId: event.agentId, workflowId: event.workflowId,
        agentName: event.agentName, agentRole: event.agentRole, sessionId: event.sessionId,
        status: next.agents.get(key)?.status })
      }
      break
    case 'agent_status_updated':
      if (event.agentId && event.status) {
        const key = orchestrationEntityKey(event.workflowId, event.agentId)
        const agent = next.agents.get(key) ?? { agentId: event.agentId, workflowId: event.workflowId }
        next.agents.set(key, { ...agent, status: event.status, reason: event.reason })
      }
      break
    case 'agent_waiting':
    case 'agent_resumed':
    case 'agent_returned':
      if (event.agentId) {
        const key = orchestrationEntityKey(event.workflowId, event.agentId)
        const agent = next.agents.get(key) ?? { agentId: event.agentId, workflowId: event.workflowId }
        next.agents.set(key, { ...agent, assignmentId: event.assignmentId ?? agent.assignmentId,
          status: event.type === 'agent_waiting' ? 'waiting' : event.type === 'agent_returned' ? 'returned' : 'active',
          ...(event.reason ? { reason: event.reason } : event.type === 'agent_resumed' ? { reason: undefined } : {}) })
      }
      break
    case 'assignment_created':
    case 'assignment_started':
    case 'assignment_updated':
    case 'assignment_blocked':
    case 'assignment_completed':
    case 'assignment_failed':
    case 'dependency_created':
      if (event.assignmentId) {
        const key = orchestrationEntityKey(event.workflowId, event.assignmentId)
        const assignment = next.assignments.get(key) ?? { assignmentId: event.assignmentId, workflowId: event.workflowId, dependencyIds: [] }
        const dependencies = event.dependencyIds ? safeDependencies(event.workflowId, event.assignmentId, event.dependencyIds, next.assignments) : assignment.dependencyIds
        const status = event.type === 'assignment_started' ? 'active' : event.type === 'assignment_blocked' ? 'blocked'
          : event.type === 'assignment_completed' ? 'completed' : event.type === 'assignment_failed' ? 'failed' : event.status
        next.assignments.set(key, { ...assignment,
          ...(event.assignmentTitle ? { assignmentTitle: event.assignmentTitle } : {}),
          ...(event.assignmentDescription ? { assignmentDescription: event.assignmentDescription } : {}),
          ...(event.agentId ? { agentId: event.agentId } : {}),
          dependencyIds: dependencies ?? assignment.dependencyIds,
          status: status ?? assignment.status,
          ...(event.metadata?.progressPercent !== undefined ? { progressPercent: event.metadata.progressPercent } : {}),
          ...(event.reason ? { reason: event.reason } : event.type === 'assignment_started' || event.type === 'assignment_completed' ? { reason: undefined } : {}) })
      }
      break
    case 'delegation_created':
      if (event.agentId && event.parentAgentId && !createsDelegationCycle(event.workflowId, event.agentId, event.parentAgentId, next.delegations)) {
        next.delegations.set(orchestrationEntityKey(event.workflowId, event.agentId), { workflowId: event.workflowId, agentId: event.agentId, parentAgentId: event.parentAgentId,
          sessionId: event.sessionId, parentSessionId: event.parentSessionId, assignmentId: event.assignmentId })
      }
      break
    case 'orchestration_message':
      break
  }

}

function indexEvents(items: OrderedOrchestrationEvent[]): Map<string, OrderedOrchestrationEvent[]> {
  const indexed = new Map<string, OrderedOrchestrationEvent[]>()
  for (const item of items) {
    const workflowEvents = indexed.get(item.event.workflowId)
    if (workflowEvents) workflowEvents.push(item)
    else indexed.set(item.event.workflowId, [item])
  }
  return indexed
}

function foldOrderedEvents(items: OrderedOrchestrationEvent[]): OrchestrationState {
  const state = createOrchestrationState()
  state.acceptedEvents = items
  state.events = items.slice(-MAX_ORCHESTRATION_TIMELINE_EVENTS)
  state.eventsByWorkflow = indexEvents(state.events)
  for (const item of items) {
    state.eventIds.add(item.event.eventId)
    state.nextIngestionIndex = Math.max(state.nextIngestionIndex, item.ingestionIndex + 1)
    state.latestTimestamp = Math.max(state.latestTimestamp, Date.parse(item.event.timestamp))
    applyEventMutable(state, item.event)
  }
  return state
}

export function reduceOrchestrationEvent(state: OrchestrationState, event: OrchestrationEvent): OrchestrationState {
  if (state.eventIds.has(event.eventId)) return state
  if (state.eventIds.size >= MAX_ORCHESTRATION_EVENTS) return state
  const item = { event, ingestionIndex: state.nextIngestionIndex }
  const timestamp = Date.parse(event.timestamp)
  if (timestamp < state.latestTimestamp) return foldOrderedEvents([...state.acceptedEvents, item].sort(compareEvents))

  const events = [...state.events, item].slice(-MAX_ORCHESTRATION_TIMELINE_EVENTS)
  const eventsByWorkflow = new Map(state.eventsByWorkflow)
  const dropped = state.events.length === MAX_ORCHESTRATION_TIMELINE_EVENTS ? state.events[0] : undefined
  if (dropped) eventsByWorkflow.set(dropped.event.workflowId, (eventsByWorkflow.get(dropped.event.workflowId) ?? []).filter(candidate => candidate !== dropped))
  eventsByWorkflow.set(event.workflowId, [...(eventsByWorkflow.get(event.workflowId) ?? []), item])

  const next: OrchestrationState = {
    ...state,
    workflows: new Map(state.workflows), memberships: new Map(state.memberships), agents: new Map(state.agents),
    assignments: new Map(state.assignments), delegations: new Map(state.delegations),
    eventIds: new Set(state.eventIds).add(event.eventId), events, eventsByWorkflow,
    acceptedEvents: [...state.acceptedEvents, item],
    nextIngestionIndex: state.nextIngestionIndex + 1, latestTimestamp: timestamp,
  }
  applyEventMutable(next, event)
  return next
}

export function reduceOrchestrationSnapshot(events: readonly OrchestrationEvent[]): OrchestrationState {
  const seen = new Set<string>()
  const items: OrderedOrchestrationEvent[] = []
  let latest = -Infinity
  let delayed = false
  for (const event of events) {
    if (seen.has(event.eventId)) continue
    if (items.length >= MAX_ORCHESTRATION_EVENTS) break
    seen.add(event.eventId)
    const timestamp = Date.parse(event.timestamp)
    if (timestamp < latest) delayed = true
    latest = Math.max(latest, timestamp)
    items.push({ event, ingestionIndex: items.length })
  }
  if (delayed) items.sort(compareEvents)
  return foldOrderedEvents(items)
}
