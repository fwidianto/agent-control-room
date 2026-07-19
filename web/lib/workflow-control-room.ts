import type { AgentEvent, OrchestrationEventType, OrchestrationStatus } from './bridge-types'
import { emptyContextBreakdown, type Agent, type Edge, type EdgeSignal } from './agent-types'
import type { AgentOrchestrationState, AssignmentOrchestrationState, OrchestrationState } from './orchestration-state'
import { orchestrationEntityKey } from './orchestration-state'
import { interpretActivity, sessionStatus, type SessionSummary } from './session-summary'

export const CONTROL_ROOM_TIMELINE_LIMIT = 5_000
export const CONTROL_ROOM_RENDER_LIMIT = 200
export const CONTROL_ROOM_GRAPH_LIMIT = 100

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

export interface WorkflowCanvasModel {
  agents: Map<string, Agent>
  edges: Edge[]
  signals: EdgeSignal[]
  totalAgents: number
}

export type AgentEdgeInteraction = {
  type: string
  label: string
  timestamp: number
  direction: 'out' | 'in' | 'pulse'
}

export interface SessionOrchestrationContext {
  workflowName: string
  agentName: string
  agentRole?: string
  sessionId: string
  parent?: { name: string; sessionId?: string }
  children: Array<{ name: string; sessionId?: string }>
  assignment: string
  status: string
  breadcrumb: Array<{ name: string; sessionId?: string }>
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

function relationshipName(agent: AgentOrchestrationState | undefined, isChild: boolean, hasExplicitChildren = false): string {
  return agent?.agentName ?? agent?.agentId ?? (isChild ? 'Child Agent' : hasExplicitChildren ? 'Root Agent' : 'Agent identity unavailable')
}

export function sessionOrchestrationContext(sessionId: string, state: OrchestrationState): SessionOrchestrationContext {
  const membership = state.memberships.get(sessionId)
  if (!membership) return { workflowName: 'Unavailable', agentName: 'Agent identity unavailable', sessionId, children: [], assignment: 'Unavailable', status: 'Unknown', breadcrumb: [] }
  const workflowId = membership.workflowId
  const workflowName = state.workflows.get(workflowId)?.workflowName ?? workflowId
  const agent = explicitAgentForSession(state, workflowId, sessionId)
  if (!agent) return { workflowName, agentName: 'Agent identity unavailable', sessionId, children: [], assignment: 'Unavailable', status: 'Unknown', breadcrumb: [] }
  const delegation = state.delegations.get(orchestrationEntityKey(workflowId, agent.agentId))
  const parentAgent = delegation ? state.agents.get(orchestrationEntityKey(workflowId, delegation.parentAgentId)) : undefined
  const children = [...state.delegations.values()].filter(item => item.workflowId === workflowId && item.parentAgentId === agent.agentId).map(item => {
    const child = state.agents.get(orchestrationEntityKey(workflowId, item.agentId))
    return { name: relationshipName(child, true), sessionId: child?.sessionId ?? item.sessionId }
  })
  const explicitAssignment = agent.assignmentId ? state.assignments.get(orchestrationEntityKey(workflowId, agent.assignmentId)) : undefined
  const ownedAssignments = [...state.assignments.values()].filter(item => item.workflowId === workflowId && item.agentId === agent.agentId)
  const assignment = explicitAssignment ?? (ownedAssignments.length === 1 ? ownedAssignments[0] : undefined)
  const path: AgentOrchestrationState[] = []
  const seen = new Set<string>()
  let current: AgentOrchestrationState | undefined = agent
  while (current && !seen.has(current.agentId)) {
    path.unshift(current)
    seen.add(current.agentId)
    const parentId: string | undefined = state.delegations.get(orchestrationEntityKey(workflowId, current.agentId))?.parentAgentId
    current = parentId ? state.agents.get(orchestrationEntityKey(workflowId, parentId)) : undefined
  }
  return {
    workflowName, agentName: relationshipName(agent, Boolean(delegation), children.length > 0), agentRole: agent.agentRole, sessionId,
    parent: delegation ? { name: parentAgent ? relationshipName(parentAgent, false) : delegation.parentAgentId, sessionId: parentAgent?.sessionId ?? delegation.parentSessionId } : undefined,
    children, assignment: assignment?.assignmentTitle ?? assignment?.assignmentId ?? 'Unavailable',
    status: agent.status ? title(agent.status) : 'Unknown',
    breadcrumb: path.map((item, index) => ({ name: relationshipName(item, index > 0,
      [...state.delegations.values()].some(edge => edge.workflowId === workflowId && edge.parentAgentId === item.agentId)), sessionId: item.sessionId })),
  }
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

export function limitAgentForest(roots: readonly AgentTreeNode[], limit: number): AgentTreeNode[] {
  let remaining = Math.max(0, limit)
  const visit = (node: AgentTreeNode): AgentTreeNode | undefined => {
    if (!remaining) return undefined
    remaining--
    const children: AgentTreeNode[] = []
    for (const child of node.children) {
      const included = visit(child)
      if (included) children.push(included)
    }
    return { agent: node.agent, children }
  }
  const limited: AgentTreeNode[] = []
  for (const root of roots) {
    const included = visit(root)
    if (included) limited.push(included)
  }
  return limited
}

const edgeEventLabels: Partial<Record<OrchestrationEventType, { label: string; direction: AgentEdgeInteraction['direction'] }>> = {
  delegation_created: { label: 'Delegated', direction: 'out' },
  assignment_started: { label: 'Assignment started', direction: 'pulse' },
  agent_waiting: { label: 'Waiting', direction: 'pulse' },
  agent_resumed: { label: 'Resumed', direction: 'pulse' },
  agent_returned: { label: 'Returned', direction: 'in' },
  assignment_completed: { label: 'Completed', direction: 'pulse' },
  assignment_failed: { label: 'Failed', direction: 'pulse' },
}

export function latestAgentEdgeInteractions(workflowId: string, state: OrchestrationState): Map<string, AgentEdgeInteraction> {
  const interactions = new Map<string, AgentEdgeInteraction>()
  const seenLifecycle = new Set<string>()
  const events = state.eventsByWorkflow.get(workflowId) ?? []
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index].event
    const mapped = edgeEventLabels[event.type]
      ?? (event.type === 'agent_status_updated' && (event.status === 'completed' || event.status === 'failed' || event.status === 'returned')
        ? { label: title(event.status), direction: 'pulse' as const } : undefined)
    const lifecycleBoundary = Boolean(mapped) || event.type.startsWith('agent_') || event.type.startsWith('assignment_')
    if (!lifecycleBoundary || !event.agentId || seenLifecycle.has(event.agentId)) continue
    seenLifecycle.add(event.agentId)
    if (mapped) interactions.set(event.agentId, { type: event.type, label: mapped.label, direction: mapped.direction, timestamp: Date.parse(event.timestamp) })
  }
  return interactions
}

export function latestAgentEdgeInteraction(workflowId: string, agentId: string, state: OrchestrationState): AgentEdgeInteraction | undefined {
  return latestAgentEdgeInteractions(workflowId, state).get(agentId)
}

function canvasAgentState(status?: OrchestrationStatus): Agent['state'] {
  if (status === 'waiting') return 'waiting'
  if (status === 'blocked') return 'blocked'
  if (status === 'failed') return 'error'
  if (status === 'returned') return 'returned'
  if (status === 'completed') return 'complete'
  if (status === 'active') return 'thinking'
  return 'idle'
}

export function buildWorkflowCanvasModel(workflowId: string, state: OrchestrationState, sessions: readonly SessionSummary[], activities: readonly SessionActivityEvent[]): WorkflowCanvasModel {
  const fullForest = buildAgentForest(workflowId, state)
  const roots = limitAgentForest(fullForest.roots, CONTROL_ROOM_GRAPH_LIMIT)
  const included = new Set<string>()
  const positions = new Map<string, { x: number; y: number }>()
  let leaf = 0
  const place = (node: AgentTreeNode, depth: number): number => {
    included.add(node.agent.agentId)
    const childXs = node.children.map(child => place(child, depth + 1))
    const x = childXs.length ? childXs.reduce((sum, value) => sum + value, 0) / childXs.length : leaf++ * 220
    positions.set(node.agent.agentId, { x, y: depth * 180 })
    return x
  }
  for (const root of roots) place(root, 0)
  const xs = [...positions.values()].map(position => position.x)
  const center = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0
  for (const position of positions.values()) position.x -= center

  const sessionsById = new Map(sessions.map(session => [session.id, session]))
  const activityCounts = new Map<string, number>()
  for (const activity of activities) if (activity.type === 'tool_call_start') activityCounts.set(activity.sessionId, (activityCounts.get(activity.sessionId) ?? 0) + 1)
  const assignmentsByAgent = new Map<string, AssignmentOrchestrationState[]>()
  for (const assignment of state.assignments.values()) if (assignment.workflowId === workflowId && assignment.agentId) {
    const assignments = assignmentsByAgent.get(assignment.agentId) ?? []
    assignments.push(assignment)
    assignmentsByAgent.set(assignment.agentId, assignments)
  }
  const agents = new Map<string, Agent>()
  for (const agent of state.agents.values()) {
    if (agent.workflowId !== workflowId || !included.has(agent.agentId)) continue
    const position = positions.get(agent.agentId)!
    const session = agent.sessionId ? sessionsById.get(agent.sessionId) : undefined
    const delegation = state.delegations.get(orchestrationEntityKey(workflowId, agent.agentId))
    const parentId = delegation && included.has(delegation.parentAgentId) ? delegation.parentAgentId : null
    const runtime = session?.runtime
    const neutral = `${runtime === 'codex' ? 'Codex' : runtime === 'claude' ? 'Claude' : 'Agent'} ${agent.sessionId ? agent.sessionId.slice(-8) : agent.agentId.slice(-8)}`
    const agentAssignments = assignmentsByAgent.get(agent.agentId) ?? []
    const explicitAssignment = agent.assignmentId ? state.assignments.get(orchestrationEntityKey(workflowId, agent.assignmentId)) : undefined
    const activeAssignments = agentAssignments.filter(assignment => assignment.status === 'active')
    const assignment = (explicitAssignment ? explicitAssignment.assignmentTitle ?? explicitAssignment.assignmentId
      : activeAssignments.length === 1 ? activeAssignments[0].assignmentTitle ?? activeAssignments[0].assignmentId
      : activeAssignments.length > 1 ? 'Multiple active assignments' : undefined)
      ?? (agentAssignments.length === 1 ? agentAssignments[0].assignmentTitle ?? agentAssignments[0].assignmentId : undefined)
    const completed = session?.status === 'completed'
    const contextKnown = session?.tokens !== undefined && session.tokensMax !== undefined
    const elapsedKnown = session !== undefined && Number.isFinite(session.startTime) && Number.isFinite(session.lastActivityTime)
    agents.set(agent.agentId, {
      id: agent.agentId, name: `${agent.agentName ?? neutral}${agent.agentRole ? ` \u00b7 ${agent.agentRole}` : ''}`,
      state: canvasAgentState(agent.status), parentId, recordedParentId: delegation?.parentAgentId,
      tokensUsed: contextKnown ? session.tokens! : 0, tokensMax: contextKnown ? session.tokensMax! : 0, contextKnown,
      contextBreakdown: emptyContextBreakdown(), toolCalls: agent.sessionId ? activityCounts.get(agent.sessionId) ?? 0 : 0,
      timeAlive: completed && elapsedKnown ? Math.max(0, (session.lastActivityTime - session.startTime) / 1000) : 0, elapsedKnown,
      x: position.x, y: position.y, vx: 0, vy: 0, pinned: true, isMain: !delegation,
      runtime, model: session?.model, currentTool: session?.activity, task: assignment,
      statusLabel: agent.status ? title(agent.status) : 'Unknown',
      spawnTime: session ? session.startTime / 1000 : 0, completeTime: completed && session ? session.lastActivityTime / 1000 : undefined, opacity: 1, scale: 1, messageBubbles: [],
    })
  }
  const edges: Edge[] = []
  for (const delegation of state.delegations.values()) if (delegation.workflowId === workflowId && included.has(delegation.parentAgentId) && included.has(delegation.agentId)) {
    edges.push({ id: `edge-${delegation.parentAgentId}-${delegation.agentId}`, from: delegation.parentAgentId, to: delegation.agentId, type: 'parent-child', opacity: 1 })
  }
  const interactions = latestAgentEdgeInteractions(workflowId, state)
  const signals: EdgeSignal[] = []
  for (const edge of edges) {
    const interaction = interactions.get(edge.to)
    if (interaction) signals.push({ edgeId: edge.id, direction: interaction.direction, label: interaction.label, timestamp: interaction.timestamp })
  }
  return { agents, edges, signals, totalAgents: [...state.agents.values()].filter(agent => agent.workflowId === workflowId).length }
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
