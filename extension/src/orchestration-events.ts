export const ORCHESTRATION_EVENT_VERSION = 1

export const ORCHESTRATION_EVENT_TYPES = [
  'workflow_session_registered',
  'workflow_started', 'workflow_updated', 'workflow_completed',
  'agent_registered', 'agent_status_updated',
  'assignment_created', 'assignment_started', 'assignment_updated', 'assignment_blocked', 'assignment_completed', 'assignment_failed',
  'delegation_created', 'dependency_created',
  'agent_waiting', 'agent_resumed', 'agent_returned',
  'orchestration_message',
] as const

export type OrchestrationEventType = typeof ORCHESTRATION_EVENT_TYPES[number]
export type OrchestrationStatus = 'active' | 'waiting' | 'blocked' | 'returned' | 'completed' | 'failed'
export interface SafeMetadata {
  attempt?: number
  priority?: string
  progressPercent?: number
  retryable?: boolean
}

interface OrchestrationEventBase {
  eventId: string
  eventVersion: 1
  type: OrchestrationEventType
  timestamp: string
  workflowId: string
  source: string
  metadata?: SafeMetadata
}

export interface WorkflowSessionRegisteredRecord extends OrchestrationEventBase {
  type: 'workflow_session_registered'
  workflowName: string
  workflowCreatedAt: string
  workflowSource: string
  workflowDescription?: string
  sessionId: string
  runtime: 'codex' | 'claude'
  expiresAt?: string
}

export interface WorkflowLifecycleEvent extends OrchestrationEventBase {
  type: 'workflow_started' | 'workflow_updated' | 'workflow_completed'
  workflowName?: string
  workflowDescription?: string
  status?: OrchestrationStatus
}

export interface AgentOrchestrationEvent extends OrchestrationEventBase {
  type: 'agent_registered' | 'agent_waiting' | 'agent_resumed' | 'agent_returned'
  agentId: string
  agentName?: string
  agentRole?: string
  sessionId?: string
  assignmentId?: string
  reason?: string
}

export interface AgentStatusUpdatedEvent extends OrchestrationEventBase {
  type: 'agent_status_updated'
  agentId: string
  status: OrchestrationStatus
  reason?: string
}

export interface AssignmentOrchestrationEvent extends OrchestrationEventBase {
  type: 'assignment_created' | 'assignment_started' | 'assignment_updated' | 'assignment_blocked' | 'assignment_completed' | 'assignment_failed'
  assignmentId: string
  assignmentTitle?: string
  assignmentDescription?: string
  agentId?: string
  dependencyIds?: string[]
  status?: OrchestrationStatus
  reason?: string
}

export interface DelegationCreatedEvent extends OrchestrationEventBase {
  type: 'delegation_created'
  agentId: string
  parentAgentId: string
  sessionId?: string
  parentSessionId?: string
  assignmentId?: string
}

export interface DependencyCreatedEvent extends OrchestrationEventBase {
  type: 'dependency_created'
  assignmentId: string
  dependencyIds: string[]
}

export interface OrchestrationMessageEvent extends OrchestrationEventBase {
  type: 'orchestration_message'
  reason: string
  agentId?: string
  sessionId?: string
  assignmentId?: string
}

export type OrchestrationEvent = WorkflowSessionRegisteredRecord | WorkflowLifecycleEvent | AgentOrchestrationEvent | AgentStatusUpdatedEvent
  | AssignmentOrchestrationEvent | DelegationCreatedEvent | DependencyCreatedEvent | OrchestrationMessageEvent

const TYPE_SET = new Set<string>(ORCHESTRATION_EVENT_TYPES)
const PRIVATE_KEYS = /(?:prompt|transcript|tool.?output|token|secret|password|credential|api.?key|authorization|cookie|environment|(?:^|_)env(?:$|_))/i
const TEXT_FIELDS = ['workflowName', 'workflowSource', 'workflowDescription', 'agentId', 'agentName', 'agentRole', 'sessionId',
  'parentAgentId', 'parentSessionId', 'assignmentId', 'assignmentTitle', 'assignmentDescription', 'reason'] as const
const MAX_ID_LENGTH = 256
const MAX_TEXT_LENGTH = 2_048
const MAX_LIST_ITEMS = 1_000

function text(value: unknown, max = MAX_TEXT_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed && trimmed.length <= max ? trimmed : undefined
}

function date(value: unknown): string | undefined {
  const parsed = text(value, 64)
  return parsed && Number.isFinite(Date.parse(parsed)) ? parsed : undefined
}

function ids(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIST_ITEMS) return undefined
  const parsed = value.map(item => text(item, MAX_ID_LENGTH))
  return parsed.every(Boolean) && new Set(parsed).size === parsed.length ? parsed as string[] : undefined
}

function safeMetadata(value: unknown): SafeMetadata | undefined | null {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.some(([key]) => !['attempt', 'priority', 'progressPercent', 'retryable'].includes(key))) return null
  const metadata = value as Record<string, unknown>
  if (metadata.attempt !== undefined && (!Number.isInteger(metadata.attempt) || (metadata.attempt as number) < 0 || (metadata.attempt as number) > 1_000_000)) return null
  if (metadata.priority !== undefined && !text(metadata.priority, 64)) return null
  if (metadata.progressPercent !== undefined && (typeof metadata.progressPercent !== 'number' || !Number.isFinite(metadata.progressPercent) || metadata.progressPercent < 0 || metadata.progressPercent > 100)) return null
  if (metadata.retryable !== undefined && typeof metadata.retryable !== 'boolean') return null
  return Object.fromEntries(entries) as SafeMetadata
}

function containsPrivateField(value: Record<string, unknown>): boolean {
  return Object.keys(value).some(key => PRIVATE_KEYS.test(key))
}

function base(record: Record<string, unknown>): OrchestrationEventBase | null {
  const eventId = text(record.eventId, MAX_ID_LENGTH)
  const timestamp = date(record.timestamp)
  const workflowId = text(record.workflowId, MAX_ID_LENGTH)
  const source = text(record.source, MAX_TEXT_LENGTH)
  const metadata = safeMetadata(record.metadata)
  if (record.eventVersion !== ORCHESTRATION_EVENT_VERSION || !TYPE_SET.has(String(record.type))
    || !eventId || !timestamp || !workflowId || !source || metadata === null || containsPrivateField(record)
    || TEXT_FIELDS.some(key => record[key] !== undefined && !text(record[key], key.endsWith('Id') ? MAX_ID_LENGTH : MAX_TEXT_LENGTH))) return null
  return { eventId, eventVersion: 1, type: record.type as OrchestrationEventType, timestamp, workflowId, source, ...(metadata ? { metadata } : {}) }
}

export function parseOrchestrationEvent(value: unknown, now = Date.now()): OrchestrationEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const common = base(record)
  if (!common) return null
  const optionalText = (key: string, max = MAX_TEXT_LENGTH) => record[key] === undefined ? undefined : text(record[key], max)
  const agentId = optionalText('agentId', MAX_ID_LENGTH)
  const sessionId = optionalText('sessionId', MAX_ID_LENGTH)
  const assignmentId = optionalText('assignmentId', MAX_ID_LENGTH)
  const reason = optionalText('reason')
  const status = record.status === undefined ? undefined
    : ['active', 'waiting', 'blocked', 'returned', 'completed', 'failed'].includes(String(record.status)) ? record.status as OrchestrationStatus : null
  if (status === null) return null
  if (status === 'returned' && (common.type.startsWith('workflow_') || common.type.startsWith('assignment_'))) return null

  switch (common.type) {
    case 'workflow_session_registered': {
      const workflowName = optionalText('workflowName')
      const workflowCreatedAt = date(record.workflowCreatedAt)
      const workflowSource = optionalText('workflowSource')
      const workflowDescription = optionalText('workflowDescription')
      const expiresAt = record.expiresAt === undefined ? undefined : date(record.expiresAt)
      if (!workflowName || !workflowCreatedAt || !workflowSource || !sessionId
        || (record.runtime !== 'codex' && record.runtime !== 'claude')
        || record.workflowDescription !== undefined && !workflowDescription
        || record.expiresAt !== undefined && (!expiresAt || Date.parse(expiresAt) <= now)) return null
      return { ...common, type: common.type, workflowName, workflowCreatedAt, workflowSource,
        ...(workflowDescription ? { workflowDescription } : {}), sessionId, runtime: record.runtime,
        ...(expiresAt ? { expiresAt } : {}) }
    }
    case 'workflow_started': {
      const workflowName = optionalText('workflowName')
      if (!workflowName) return null
      return { ...common, type: common.type, workflowName, ...(optionalText('workflowDescription') ? { workflowDescription: optionalText('workflowDescription') } : {}), ...(status ? { status } : {}) }
    }
    case 'workflow_updated': {
      const workflowName = optionalText('workflowName')
      const workflowDescription = optionalText('workflowDescription')
      if (!workflowName && !workflowDescription && !status) return null
      return { ...common, type: common.type, ...(workflowName ? { workflowName } : {}), ...(workflowDescription ? { workflowDescription } : {}), ...(status ? { status } : {}) }
    }
    case 'workflow_completed':
      return { ...common, type: common.type, status: 'completed' }
    case 'agent_registered': {
      const agentName = optionalText('agentName')
      if (!agentId || !agentName) return null
      return { ...common, type: common.type, agentId, agentName, ...(optionalText('agentRole') ? { agentRole: optionalText('agentRole') } : {}), ...(sessionId ? { sessionId } : {}) }
    }
    case 'agent_status_updated':
      if (!agentId || !status) return null
      return { ...common, type: common.type, agentId, status, ...(reason ? { reason } : {}) }
    case 'agent_waiting':
    case 'agent_resumed':
    case 'agent_returned':
      if (!agentId) return null
      return { ...common, type: common.type, agentId, ...(sessionId ? { sessionId } : {}), ...(assignmentId ? { assignmentId } : {}), ...(reason ? { reason } : {}) }
    case 'assignment_created': {
      const assignmentTitle = optionalText('assignmentTitle')
      if (!assignmentId || !assignmentTitle) return null
      const dependencyIds = record.dependencyIds === undefined ? undefined : ids(record.dependencyIds)
      if (record.dependencyIds !== undefined && !dependencyIds) return null
      return { ...common, type: common.type, assignmentId, assignmentTitle,
        ...(optionalText('assignmentDescription') ? { assignmentDescription: optionalText('assignmentDescription') } : {}),
        ...(agentId ? { agentId } : {}), ...(dependencyIds ? { dependencyIds } : {}), ...(status ? { status } : {}) }
    }
    case 'assignment_started':
      if (!assignmentId || !agentId) return null
      return { ...common, type: common.type, assignmentId, agentId, status: 'active' }
    case 'assignment_updated': {
      if (!assignmentId) return null
      const assignmentTitle = optionalText('assignmentTitle')
      const assignmentDescription = optionalText('assignmentDescription')
      const dependencyIds = record.dependencyIds === undefined ? undefined : ids(record.dependencyIds)
      if (record.dependencyIds !== undefined && !dependencyIds) return null
      if (!assignmentTitle && !assignmentDescription && !agentId && !dependencyIds && !status) return null
      return { ...common, type: common.type, assignmentId, ...(assignmentTitle ? { assignmentTitle } : {}),
        ...(assignmentDescription ? { assignmentDescription } : {}), ...(agentId ? { agentId } : {}),
        ...(dependencyIds ? { dependencyIds } : {}), ...(status ? { status } : {}) }
    }
    case 'assignment_blocked':
    case 'assignment_completed':
    case 'assignment_failed':
      if (!assignmentId) return null
      return { ...common, type: common.type, assignmentId,
        status: common.type === 'assignment_blocked' ? 'blocked' : common.type === 'assignment_completed' ? 'completed' : 'failed',
        ...(reason ? { reason } : {}) }
    case 'delegation_created': {
      const parentAgentId = optionalText('parentAgentId', MAX_ID_LENGTH)
      if (!agentId || !parentAgentId || agentId === parentAgentId) return null
      return { ...common, type: common.type, agentId, parentAgentId, ...(sessionId ? { sessionId } : {}),
        ...(optionalText('parentSessionId', MAX_ID_LENGTH) ? { parentSessionId: optionalText('parentSessionId', MAX_ID_LENGTH) } : {}),
        ...(assignmentId ? { assignmentId } : {}) }
    }
    case 'dependency_created': {
      const dependencyIds = ids(record.dependencyIds)
      if (!assignmentId || !dependencyIds || dependencyIds.includes(assignmentId)) return null
      return { ...common, type: common.type, assignmentId, dependencyIds }
    }
    case 'orchestration_message':
      if (!reason || (!agentId && !sessionId && !assignmentId)) return null
      return { ...common, type: common.type, reason, ...(agentId ? { agentId } : {}), ...(sessionId ? { sessionId } : {}), ...(assignmentId ? { assignmentId } : {}) }
  }
}

export type OrchestrationUpdateMessage =
  | { type: 'orchestration-snapshot'; events: OrchestrationEvent[] }
  | { type: 'orchestration-event-batch'; events: OrchestrationEvent[] }

export function selectOrchestrationUpdate(previousEventIds: readonly string[] | undefined, events: readonly OrchestrationEvent[]): OrchestrationUpdateMessage {
  if (!previousEventIds) return { type: 'orchestration-snapshot', events: [...events] }
  const appendOnly = previousEventIds.every((id, index) => events[index]?.eventId === id)
  return appendOnly
    ? { type: 'orchestration-event-batch', events: events.slice(previousEventIds.length) }
    : { type: 'orchestration-snapshot', events: [...events] }
}
