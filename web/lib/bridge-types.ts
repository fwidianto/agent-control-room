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

export type ConnectionStatus = 'connected' | 'disconnected' | 'watching'
