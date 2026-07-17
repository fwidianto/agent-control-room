import type { AgentEvent, SessionInfo } from './bridge-types'

export interface SessionSummary extends SessionInfo {
  model?: string
  activity?: string
  waiting?: boolean
  tokens?: number
  tokensMax?: number
}

export function sessionStatus(session: SessionSummary): 'Active' | 'Waiting' | 'Inactive' {
  if (session.status === 'completed') return 'Inactive'
  return session.waiting ? 'Waiting' : 'Active'
}

export function openSessionDetails(id: string, select: (id: string) => void, closeOverview: () => void): void {
  select(id)
  closeOverview()
}

export function shortSessionId(id: string): string { return id.slice(-8) }

function text(value: unknown): string { return typeof value === 'string' ? value : '' }

export function interpretActivity(event: AgentEvent): string | undefined {
  if (event.type === 'permission_requested' || event.type === 'agent_idle') return 'Waiting for another result'
  if (event.type === 'tool_call_end') return 'Reviewing command output'
  if (event.type === 'message') return 'Reviewing a message'
  if (event.type !== 'tool_call_start') return undefined

  const tool = text(event.payload.tool).toLowerCase()
  const detail = `${text(event.payload.args)} ${text(event.payload.preview)}`.toLowerCase()
  if (/websearch|webfetch|web_search|search_query/.test(tool) || /web__run|web\.run|search_query/.test(detail)) return 'Performing a web search'
  if (/test/.test(tool) || /\b(test|jest|vitest|pytest|cargo test|go test|pnpm(?:\.cmd)?\s+(?:run\s+)?test)\b/.test(detail)) return 'Running tests'
  if (/^(edit|write|apply_patch)$/.test(tool) || /apply_patch/.test(detail)) return 'Editing a file'
  if (/grep|glob|search|find/.test(tool) || /\brg\b|select-string/.test(detail)) return 'Searching the codebase'
  if (/read|view/.test(tool) || /get-content/.test(detail)) return /agents\.md|instructions|skill\.md/.test(detail)
    ? 'Reading repository instructions' : 'Inspecting source files'
  return 'Running a tool'
}

export function updateSessionSummary(session: SessionSummary, event: AgentEvent): SessionSummary {
  const activity = interpretActivity(event)
  const next: SessionSummary = {
    ...session,
    lastActivityTime: Math.max(session.lastActivityTime, session.startTime + event.time * 1000),
    waiting: event.type === 'permission_requested' || event.type === 'agent_idle'
      ? true : activity ? false : session.waiting,
    ...(activity ? { activity } : {}),
  }
  const isMainAgent = event.payload.agent === undefined || event.payload.agent === 'orchestrator'
  if (isMainAgent && event.type === 'model_detected' && typeof event.payload.model === 'string') next.model = event.payload.model
  if (isMainAgent && event.type === 'context_update') {
    if (typeof event.payload.tokens === 'number') next.tokens = event.payload.tokens
    if (typeof event.payload.tokensMax === 'number') next.tokensMax = event.payload.tokensMax
  }
  return next
}

export function summarizeSessionEvents(session: SessionSummary, events: AgentEvent[]): SessionSummary {
  return events.reduce(updateSessionSummary, session)
}
