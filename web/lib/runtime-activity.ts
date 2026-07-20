import type { AgentEvent, SessionInfo } from './bridge-types'

export type RuntimeName = 'codex' | 'claude' | 'unknown'
export type ActivityOperation = 'read' | 'inspect' | 'edit' | 'apply_patch' | 'execute' | 'test' | 'tool' | 'return'
export type ActivityArtifactType = 'file' | 'command' | 'test' | 'tool' | 'patch' | 'result'
export type ActivityPhase = 'start' | 'complete'
export type ActivityStatus = 'running' | 'completed' | 'failed' | 'unknown'
export type ActivityAuthority = 'authoritative' | 'observed' | 'unavailable'
export type ActivityConfidence = 'high' | 'medium' | 'unknown'
export type ActivityEvidenceSource = 'claude-runtime' | 'codex-rollout' | 'orchestration' | 'unknown'

export interface RuntimeActivityEvent {
  id: string
  runtime: RuntimeName
  workflowId?: string
  sessionId: string
  agentId?: string
  timestamp: number
  callId: string
  operation: ActivityOperation
  artifactType: ActivityArtifactType
  artifactId: string
  label: string
  phase: ActivityPhase
  status: ActivityStatus
  evidenceSource: ActivityEvidenceSource
  authority: ActivityAuthority
  confidence: ActivityConfidence
  completedAt?: number
  durationMs?: number
  exitStatus?: number
}

export interface RuntimeActivityState {
  events: Map<string, RuntimeActivityEvent>
}

export const MAX_RUNTIME_ACTIVITY = 1_000
export const RUNTIME_ACTIVITY_VISIBLE_MS = 12_000

const LABEL_MAX = 80
const COMMAND_MAX = 120

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function bounded(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

function hash(value: string): string {
  let result = 2166136261
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(16).padStart(8, '0')
}

function slashPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/')
}

function pathIsAbsolute(value: string): boolean {
  return /^([A-Za-z]:\/|\/)/.test(value)
}

function safeSegment(value: string): boolean {
  return !/(?:^|\/)(?:\.env|id_rsa|credentials?|secrets?|cookies?)(?:$|\/|\.)/i.test(value)
}

/** Return a workspace-relative path or a neutral external-file label. */
export function sanitizePath(value: unknown, workspace?: string): string | undefined {
  const raw = bounded(slashPath(stringValue(value)), 240)
  if (!raw || !safeSegment(raw)) return raw ? 'Protected file' : undefined

  const root = bounded(slashPath(stringValue(workspace)).replace(/\/$/, ''), 240)
  const folded = raw.toLowerCase()
  const foldedRoot = root.toLowerCase()
  if (root && (folded === foldedRoot || folded.startsWith(`${foldedRoot}/`))) {
    const relative = raw.slice(root.length).replace(/^\/+/, '')
    return bounded(relative || 'Workspace root', 96)
  }
  if (!pathIsAbsolute(raw)) return bounded(raw.replace(/^\.\//, ''), 96)
  return 'External file'
}

/** Remove secrets and absolute paths before a command reaches the canvas. */
export function sanitizeCommand(value: unknown, workspace?: string): string | undefined {
  let command = bounded(stringValue(value), COMMAND_MAX)
  if (!command) return undefined
  command = command
    .replace(/https?:\/\/[^\s'"`]+/gi, '<url>')
    .replace(/\b[A-Za-z0-9-]*(?:token|key|secret|password|credential|cookie|authorization)[A-Za-z0-9-]*\s*:\s*(?:"[^"]*"|'[^']*'|[^\r\n]+)/gi, '<redacted-header>')
    .replace(/\b(?:Bearer\s+|(?:--?|\/)\s*(?:token|password|secret|api[-_]?key|auth)[=\s])(?:"[^"]*"|'[^']*'|[^\s]+)/gi, '<redacted>')
    .replace(/\b[A-Z_]*(?:TOKEN|KEY|SECRET|PASSWORD|COOKIE|CREDENTIAL)[A-Z_]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s]+)/gi, '<redacted-assignment>')
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/g, '<redacted>')
  command = command.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s'"`]+/g, match => {
    const safe = sanitizePath(slashPath(match), workspace)
    return safe && safe !== 'External file' ? safe : '<path>'
  })
  return bounded(command, COMMAND_MAX)
}

function runtimeFrom(value: unknown): RuntimeName {
  return value === 'codex' || value === 'claude' ? value : 'unknown'
}

function sourceFor(runtime: RuntimeName): ActivityEvidenceSource {
  return runtime === 'codex' ? 'codex-rollout' : runtime === 'claude' ? 'claude-runtime' : 'unknown'
}

function testCommand(value: string): boolean {
  return /(?:^|\s)(?:pnpm(?:\.cmd)?|npm|yarn|bun)\s+(?:run\s+)?(?:test|lint:test)(?:\s|$)/i.test(value)
    || /(?:^|\s)(?:cargo|go|dotnet)\s+test(?:\s|$)/i.test(value)
    || /(?:^|\s)(?:pytest|jest|vitest|mocha|ctest)(?:\s|$)/i.test(value)
    || /(?:^|\s)(?:node|tsx|ts-node|deno)\b[^\r\n]*\s--test(?:\s|$)/i.test(value)
}

function inspectionCommand(value: string): boolean {
  return /(?:^|\s)(?:rg|grep|find|cat|head|tail|sed|awk|git\s+(?:diff|show|status)|get-content|select-string)(?:\s|$)/i.test(value)
}

function patchPath(value: string, workspace?: string): string | undefined {
  const match = value.match(/\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*([^\r\n]+)/i)
  return sanitizePath(match?.[1], workspace)
}

function nestedCommand(value: string, workspace?: string): string | undefined {
  const match = value.match(/(?:command|cmd)\s*[:=]\s*["'`]([^"'`\r\n]{1,180})/i)
  return sanitizeCommand(match?.[1] ?? value, workspace)
}

interface ClassifiedActivity {
  operation: ActivityOperation
  artifactType: ActivityArtifactType
  artifactLabel: string
  artifactId: string
}

function classify(toolName: string, args: string, inputData: Record<string, unknown> | undefined, workspace?: string): ClassifiedActivity {
  const tool = toolName.toLowerCase()
  const file = sanitizePath(inputData?.file_path ?? inputData?.path ?? inputData?.notebook_path, workspace)
  const command = sanitizeCommand(inputData?.command ?? inputData?.cmd ?? args, workspace)

  if (tool === 'read' || tool === 'view_image') {
    return { operation: 'read', artifactType: 'file', artifactLabel: file ? `Reading · ${file}` : 'Reading · File unavailable', artifactId: `file:${file ?? 'unavailable'}` }
  }
  if (tool === 'edit' || tool === 'write' || tool === 'notebookedit') {
    return { operation: 'edit', artifactType: 'file', artifactLabel: file ? `Editing · ${file}` : 'Editing · File unavailable', artifactId: `file:${file ?? 'unavailable'}` }
  }
  if (tool === 'glob' || tool === 'grep') {
    return { operation: 'inspect', artifactType: file ? 'file' : 'tool', artifactLabel: file ? `Inspecting · ${file}` : 'Inspecting · Tool target unavailable', artifactId: `${file ? 'file' : 'tool'}:${file ?? tool}` }
  }
  if (tool === 'apply_patch' || /\bapply_patch\b/i.test(args)) {
    const target = patchPath(stringValue(inputData?.patch) || args, workspace)
    return { operation: 'apply_patch', artifactType: 'patch', artifactLabel: target ? `Applying patch · ${target}` : 'Applying patch · Change set', artifactId: `patch:${target ?? hash(args)}` }
  }
  if (tool === 'bash' || tool === 'exec_command' || tool === 'shell_command' || tool === 'writestdin' || tool === 'exec') {
    const nested = tool === 'exec' ? nestedCommand(args, workspace) : command
    const test = nested ? testCommand(nested) : testCommand(args)
    const inspect = !test && (nested ? inspectionCommand(nested) : inspectionCommand(args))
    const label = nested ? `${test ? 'Testing' : inspect ? 'Inspecting' : 'Running'} · ${nested}`
      : test ? 'Testing · Command unavailable' : inspect ? 'Inspecting · Command unavailable' : 'Running · Command unavailable'
    const operation: ActivityOperation = test ? 'test' : inspect ? 'inspect' : 'execute'
    return { operation, artifactType: operation === 'test' ? 'test' : operation === 'execute' ? 'command' : 'tool', artifactLabel: label, artifactId: `call:${hash(`${toolName}:${args}`)}` }
  }
  return { operation: 'tool', artifactType: 'tool', artifactLabel: `Using · ${bounded(toolName || 'Unknown tool', 48)}`, artifactId: `tool:${bounded(toolName || 'unknown', 48)}` }
}

export function createRuntimeActivityState(): RuntimeActivityState {
  return { events: new Map() }
}

export function normalizeAgentEvent(event: AgentEvent, session?: SessionInfo): RuntimeActivityEvent | null {
  if (event.type !== 'tool_call_start' && event.type !== 'tool_call_end') return null
  if (!event.sessionId) return null

  const payload = event.payload ?? {}
  const toolName = stringValue(payload.tool) || 'unknown'
  const args = stringValue(payload.args)
  const inputData = recordValue(payload.inputData)
  const runtime = runtimeFrom(session?.runtime ?? payload.runtime)
  const classified = classify(toolName, args, inputData, session?.workspace)
  const callId = stringValue(payload.callId) || stringValue(payload.toolUseId) || `fallback:${hash(`${event.sessionId}:${event.time}:${toolName}:${args}`)}`
  const timestamp = Number.isFinite(session?.startTime) ? session!.startTime + Math.max(0, event.time) * 1000 : Date.now()
  const phase: ActivityPhase = event.type === 'tool_call_start' ? 'start' : 'complete'
  const status: ActivityStatus = phase === 'start' ? 'running'
    : payload.isError === true || (typeof payload.exitCode === 'number' && payload.exitCode !== 0) || payload.success === false ? 'failed'
    : 'unknown'
  const eventId = `activity:${event.sessionId}:${callId}`

  return {
    id: eventId,
    runtime,
    workflowId: session?.workflow?.workflowId,
    sessionId: event.sessionId,
    timestamp,
    callId,
    operation: classified.operation,
    artifactType: classified.artifactType,
    artifactId: `${event.sessionId}:${classified.artifactId}`,
    label: bounded(classified.artifactLabel, LABEL_MAX),
    phase,
    status,
    evidenceSource: sourceFor(runtime),
    authority: 'observed',
    confidence: 'high',
    ...(phase === 'complete' ? { completedAt: timestamp } : {}),
    ...(typeof payload.exitCode === 'number' ? { exitStatus: payload.exitCode } : {}),
  }
}

export function normalizeReturnActivity(event: { eventId: string; timestamp: string; workflowId: string; sessionId?: string; agentId?: string; type: string }): RuntimeActivityEvent | null {
  if (event.type !== 'agent_returned' || !event.sessionId) return null
  const timestamp = Date.parse(event.timestamp)
  if (!Number.isFinite(timestamp)) return null
  const callId = `return:${event.agentId ?? event.sessionId}`
  return {
    id: `activity:${event.eventId}`,
    runtime: 'unknown', workflowId: event.workflowId, sessionId: event.sessionId, agentId: event.agentId,
    timestamp, callId, operation: 'return', artifactType: 'result', artifactId: `return:${event.agentId ?? event.sessionId}`,
    label: 'Returning control · outcome unavailable', phase: 'complete', status: 'unknown', evidenceSource: 'orchestration',
    authority: 'authoritative', confidence: 'high', completedAt: timestamp,
  }
}

export function reduceRuntimeActivity(state: RuntimeActivityState, event: RuntimeActivityEvent): RuntimeActivityState {
  const previous = state.events.get(event.id)
  const merged: RuntimeActivityEvent = previous && previous.phase === 'start' && event.phase === 'complete'
    ? { ...previous, ...event, timestamp: previous.timestamp, operation: previous.operation, artifactType: previous.artifactType,
      artifactId: previous.artifactId, label: previous.label, completedAt: event.timestamp, durationMs: Math.max(0, event.timestamp - previous.timestamp) }
    : previous && previous.phase === 'complete' && event.phase === 'start'
    ? { ...previous, timestamp: event.timestamp, operation: event.operation, artifactType: event.artifactType, artifactId: event.artifactId, label: event.label, completedAt: previous.completedAt ?? previous.timestamp,
      durationMs: Math.max(0, (previous.completedAt ?? previous.timestamp) - event.timestamp) }
    : previous && previous.phase === 'complete'
    ? previous
    : event
  const events = new Map(state.events)
  events.set(event.id, merged)
  if (events.size > MAX_RUNTIME_ACTIVITY) {
    // ponytail: bounded sort is O(n log n); raise the cap only after measuring a real replay bottleneck.
    const keep = [...events.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id)).slice(-MAX_RUNTIME_ACTIVITY)
    return { events: new Map(keep.map(item => [item.id, item])) }
  }
  return { events }
}

export function runtimeActivityList(state: RuntimeActivityState): RuntimeActivityEvent[] {
  return [...state.events.values()].sort((a, b) => a.timestamp - b.timestamp || a.phase.localeCompare(b.phase) || a.id.localeCompare(b.id))
}

export function replayRuntimeActivity(events: readonly RuntimeActivityEvent[], now: number): RuntimeActivityEvent[] {
  return [...events]
    .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
    .filter(event => event.timestamp <= now)
    .map(event => event.phase === 'complete' && event.completedAt && now < event.completedAt
      ? { ...event, phase: 'start' as const, status: 'running' as const, completedAt: undefined, durationMs: undefined }
      : event)
}

export function runtimeActivityReplayEnd(events: readonly RuntimeActivityEvent[], fallback: number): number {
  const start = events[0]?.timestamp ?? fallback
  return events.reduce((end, event) => Math.max(end, event.completedAt ?? event.timestamp), start)
}

export function visibleRuntimeActivity(state: RuntimeActivityState, now: number): RuntimeActivityEvent[] {
  return runtimeActivityList(state).filter(event => event.status === 'running' || !event.completedAt || now - event.completedAt <= RUNTIME_ACTIVITY_VISIBLE_MS)
}
