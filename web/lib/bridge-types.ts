/**
 * Shared types for the VS Code bridge protocol.
 *
 * These types mirror extension/src/protocol.ts and are kept separate
 * to avoid cross-project imports. When updating these, also update
 * the canonical definitions in extension/src/protocol.ts.
 */

export interface AgentEvent {
  time: number
  type: string
  payload: Record<string, unknown>
  sessionId?: string
}

export interface SessionInfo {
  id: string
  label: string
  status: 'active' | 'completed'
  startTime: number
  lastActivityTime: number
  runtime?: 'codex' | 'claude'
  workspace?: string
  workflow?: WorkflowIdentity
  workflowMetadataStatus?: WorkflowMetadataStatus
}

export type WorkflowMetadataStatus = 'invalid' | 'expired'

export interface WorkflowIdentity {
  workflowId: string
  workflowName: string
  workflowCreatedAt: string
  workflowSource: string
  workflowDescription?: string
  provenance: 'Explicit orchestration event'
}

export type OrchestrationStatus = 'active' | 'waiting' | 'blocked' | 'returned' | 'completed' | 'failed'
export type OrchestrationEventType =
  | 'workflow_session_registered' | 'workflow_started' | 'workflow_updated' | 'workflow_completed'
  | 'agent_registered' | 'agent_status_updated' | 'assignment_created' | 'assignment_started' | 'assignment_updated'
  | 'assignment_blocked' | 'assignment_completed' | 'assignment_failed' | 'delegation_created'
  | 'dependency_created' | 'agent_waiting' | 'agent_resumed' | 'agent_returned' | 'orchestration_message'

export interface OrchestrationEvent {
  eventId: string
  eventVersion: 1
  type: OrchestrationEventType
  timestamp: string
  workflowId: string
  source: string
  metadata?: { attempt?: number; priority?: string; progressPercent?: number; retryable?: boolean }
  workflowName?: string
  workflowCreatedAt?: string
  workflowSource?: string
  workflowDescription?: string
  runtime?: 'codex' | 'claude'
  expiresAt?: string
  agentId?: string
  agentName?: string
  agentRole?: string
  sessionId?: string
  parentAgentId?: string
  parentSessionId?: string
  assignmentId?: string
  assignmentTitle?: string
  assignmentDescription?: string
  dependencyIds?: string[]
  status?: OrchestrationStatus
  reason?: string
}

export type ConnectionStatus = 'connected' | 'disconnected' | 'watching'
