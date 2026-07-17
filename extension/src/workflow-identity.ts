import * as fs from 'fs'
import * as path from 'path'
import { ORCHESTRATION_EVENT_VERSION, parseOrchestrationEvent, type OrchestrationEvent, type WorkflowSessionRegisteredRecord } from './orchestration-events'

export const WORKFLOW_EVENT_VERSION = ORCHESTRATION_EVENT_VERSION
export const MAX_WORKFLOW_LOG_BYTES = 5 * 1024 * 1024
export const MAX_WORKFLOW_LINE_BYTES = 16 * 1024
export const MAX_WORKFLOW_RECORDS = 10_000
export const MAX_WORKFLOW_EVENT_IDS = 10_000
export const MAX_WORKFLOW_CONFLICTS = 1_000
export const MAX_WORKFLOW_DIAGNOSTICS = 100

export type WorkflowMetadataStatus = 'invalid' | 'expired'
export type WorkflowDiagnosticCode = 'malformed' | 'unsupported' | 'expired' | 'duplicate' | 'conflict' | 'overflow'

export interface WorkflowReaderDiagnostic {
  code: WorkflowDiagnosticCode
  sessionId?: string
  runtime?: 'codex' | 'claude'
}

export interface WorkflowIdentity {
  workflowId: string
  workflowName: string
  workflowCreatedAt: string
  workflowSource: string
  workflowDescription?: string
  provenance: 'Explicit orchestration event'
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function parseWorkflowSessionRecord(value: unknown, now = Date.now()): WorkflowSessionRegisteredRecord | null {
  const event = parseOrchestrationEvent(value, now)
  return event?.type === 'workflow_session_registered' ? event : null
}

export function resolveWorkflowLogPath(workspace: string, override = process.env.AGENT_FLOW_ORCHESTRATION_LOG): string {
  if (!override) return path.join(workspace, '.agent-flow', 'orchestration.jsonl')
  return path.isAbsolute(override) ? override : path.resolve(workspace, override)
}

export class WorkflowIdentityReader {
  private readonly identities = new Map<string, WorkflowIdentity & { expiresAt?: string; runtime: 'codex' | 'claude' }>()
  private readonly workflowDefinitions = new Map<string, WorkflowIdentity>()
  private readonly eventIds = new Set<string>()
  private readonly conflictedSessions = new Set<string>()
  private readonly conflictedWorkflows = new Set<string>()
  private readonly metadataStatuses = new Map<string, { runtime: 'codex' | 'claude'; status: WorkflowMetadataStatus }>()
  private readonly diagnostics: WorkflowReaderDiagnostic[] = []
  private readonly orchestrationEvents: OrchestrationEvent[] = []
  private offset = 0
  private recordCount = 0
  private remainder = ''
  private timer: NodeJS.Timeout | null = null
  private fileKey = ''
  private visibleSnapshot = ''
  private overflowed = false

  constructor(readonly filePath: string) {}

  get(sessionId: string, runtime?: 'codex' | 'claude', now = Date.now()): WorkflowIdentity | undefined {
    const identity = this.identities.get(sessionId)
    if (!identity || (runtime && identity.runtime !== runtime) || (identity.expiresAt && Date.parse(identity.expiresAt) <= now)) return undefined
    const { expiresAt: _expiresAt, runtime: _runtime, ...publicIdentity } = identity
    return publicIdentity
  }

  getMetadataStatus(sessionId: string, runtime?: 'codex' | 'claude'): WorkflowMetadataStatus | undefined {
    const metadata = this.metadataStatuses.get(sessionId)
    return metadata && (!runtime || metadata.runtime === runtime) ? metadata.status : undefined
  }

  getDiagnostics(): readonly WorkflowReaderDiagnostic[] { return [...this.diagnostics] }
  getOrchestrationEvents(now = Date.now()): readonly OrchestrationEvent[] {
    return this.orchestrationEvents.filter(event => event.type !== 'workflow_session_registered'
      || this.get(event.sessionId, event.runtime, now)?.workflowId === event.workflowId)
  }

  apply<T extends { id: string; runtime?: 'codex' | 'claude'; workflow?: WorkflowIdentity; workflowMetadataStatus?: WorkflowMetadataStatus }>(session: T): T & { workflow?: WorkflowIdentity; workflowMetadataStatus?: WorkflowMetadataStatus } {
    const { workflow: _workflow, workflowMetadataStatus: _status, ...base } = session
    const workflow = this.get(session.id, session.runtime)
    if (workflow) return { ...base, workflow } as T & { workflow: WorkflowIdentity }
    const workflowMetadataStatus = this.getMetadataStatus(session.id, session.runtime)
    return (workflowMetadataStatus ? { ...base, workflowMetadataStatus } : base) as T & { workflowMetadataStatus?: WorkflowMetadataStatus }
  }

  refresh(now = Date.now()): boolean {
    let stat: fs.Stats
    try { stat = fs.statSync(this.filePath) } catch {
      this.reset()
      return this.commitSnapshot(now)
    }
    if (!stat.isFile()) {
      this.reset()
      return this.commitSnapshot(now)
    }
    if (stat.size > MAX_WORKFLOW_LOG_BYTES) {
      this.overflow()
      return this.commitSnapshot(now)
    }
    const nextFileKey = `${stat.dev}:${stat.ino}`
    if ((this.fileKey && this.fileKey !== nextFileKey) || stat.size < this.offset) this.reset()
    this.fileKey = nextFileKey
    if (stat.size === this.offset) {
      this.removeExpired(now)
      return this.commitSnapshot(now)
    }

    const length = stat.size - this.offset
    const buffer = Buffer.alloc(length)
    const fd = fs.openSync(this.filePath, 'r')
    try { fs.readSync(fd, buffer, 0, length, this.offset) } finally { fs.closeSync(fd) }
    this.offset = stat.size
    const lines = (this.remainder + buffer.toString('utf8')).split(/\r?\n/)
    this.remainder = lines.pop() ?? ''
    if (Buffer.byteLength(this.remainder, 'utf8') > MAX_WORKFLOW_LINE_BYTES) this.overflow()
    for (const line of lines) {
      if (this.overflowed) break
      this.recordCount++
      if (this.recordCount > MAX_WORKFLOW_RECORDS || Buffer.byteLength(line, 'utf8') > MAX_WORKFLOW_LINE_BYTES) {
        this.overflow()
        break
      }
      this.ingest(line, now)
    }
    this.removeExpired(now)
    return this.commitSnapshot(now)
  }

  start(onChange: () => void, intervalMs = 1000): void {
    if (this.timer) return
    this.refresh()
    this.timer = setInterval(() => { if (this.refresh()) onChange() }, intervalMs)
    this.timer.unref?.()
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private ingest(line: string, now: number): void {
    if (!line.trim()) return
    let value: unknown
    try { value = JSON.parse(line) } catch { this.addDiagnostic({ code: 'malformed' }); return }
    const attributable = this.attribution(value)
    const event = parseOrchestrationEvent(value, now)
    if (!event) {
      const raw = value as Record<string, unknown>
      const code: WorkflowDiagnosticCode = raw.eventVersion !== WORKFLOW_EVENT_VERSION ? 'unsupported'
        : typeof raw.expiresAt === 'string' && Number.isFinite(Date.parse(raw.expiresAt)) && Date.parse(raw.expiresAt) <= now ? 'expired' : 'malformed'
      this.addDiagnostic({ code, ...attributable })
      if (raw.type === 'workflow_session_registered' && attributable) this.invalidate(attributable.sessionId, attributable.runtime, code === 'expired' ? 'expired' : 'invalid')
      return
    }
    if (this.eventIds.has(event.eventId)) {
      this.addDiagnostic({ code: 'duplicate', ...(event.type === 'workflow_session_registered' ? { sessionId: event.sessionId, runtime: event.runtime } : {}) })
      return
    }
    if (this.eventIds.size >= MAX_WORKFLOW_EVENT_IDS) { this.overflow(); return }
    this.eventIds.add(event.eventId)
    if (event.type !== 'workflow_session_registered') { this.orchestrationEvents.push(event); return }
    const record = event
    if (this.conflictedSessions.has(record.sessionId) || this.conflictedWorkflows.has(record.workflowId)) return
    const identity: WorkflowIdentity = {
      workflowId: record.workflowId,
      workflowName: record.workflowName,
      workflowCreatedAt: record.workflowCreatedAt,
      workflowSource: record.workflowSource,
      ...(record.workflowDescription ? { workflowDescription: record.workflowDescription } : {}),
      provenance: 'Explicit orchestration event',
    }
    const definition = this.workflowDefinitions.get(record.workflowId)
    if (definition && JSON.stringify(definition) !== JSON.stringify(identity)) {
      this.workflowDefinitions.delete(record.workflowId)
      this.conflictedWorkflows.add(record.workflowId)
      for (const [sessionId, current] of this.identities) {
        if (current.workflowId === record.workflowId) this.invalidate(sessionId, current.runtime, 'invalid')
      }
      this.addDiagnostic({ code: 'conflict', sessionId: record.sessionId, runtime: record.runtime })
      if (this.conflictedSessions.size + this.conflictedWorkflows.size > MAX_WORKFLOW_CONFLICTS) this.overflow()
      return
    }
    this.workflowDefinitions.set(record.workflowId, identity)

    const candidate = { ...identity, ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}), runtime: record.runtime }
    const current = this.identities.get(record.sessionId)
    if (current && JSON.stringify(current) !== JSON.stringify(candidate)) {
      this.invalidate(record.sessionId, record.runtime, 'invalid')
      this.conflictedSessions.add(record.sessionId)
      this.addDiagnostic({ code: 'conflict', sessionId: record.sessionId, runtime: record.runtime })
      if (this.conflictedSessions.size + this.conflictedWorkflows.size > MAX_WORKFLOW_CONFLICTS) this.overflow()
      return
    }
    this.metadataStatuses.delete(record.sessionId)
    this.identities.set(record.sessionId, candidate)
    this.orchestrationEvents.push(record)
  }

  private reset(): boolean {
    const changed = this.identities.size > 0 || this.orchestrationEvents.length > 0
    this.identities.clear()
    this.workflowDefinitions.clear()
    this.eventIds.clear()
    this.conflictedSessions.clear()
    this.conflictedWorkflows.clear()
    this.metadataStatuses.clear()
    this.diagnostics.length = 0
    this.orchestrationEvents.length = 0
    this.offset = 0
    this.recordCount = 0
    this.remainder = ''
    this.fileKey = ''
    this.overflowed = false
    return changed
  }

  private snapshot(now: number): string {
    return JSON.stringify({ identities: [...this.identities]
      .filter(([, identity]) => !identity.expiresAt || Date.parse(identity.expiresAt) > now)
      .map(([sessionId, identity]) => [sessionId, identity.workflowId]).concat(
        [...this.metadataStatuses].map(([sessionId, metadata]) => [sessionId, metadata.status]),
      ), events: this.getOrchestrationEvents(now).map(event => event.eventId) })
  }

  private commitSnapshot(now: number): boolean {
    const next = this.snapshot(now)
    const changed = next !== this.visibleSnapshot
    this.visibleSnapshot = next
    return changed
  }

  private attribution(value: unknown): { sessionId: string; runtime: 'codex' | 'claude' } | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    return nonEmpty(record.sessionId) && (record.runtime === 'codex' || record.runtime === 'claude')
      ? { sessionId: record.sessionId, runtime: record.runtime } : undefined
  }

  private invalidate(sessionId: string, runtime: 'codex' | 'claude', status: WorkflowMetadataStatus): void {
    this.identities.delete(sessionId)
    if (this.metadataStatuses.size >= MAX_WORKFLOW_RECORDS && !this.metadataStatuses.has(sessionId)) { this.overflow(); return }
    this.metadataStatuses.set(sessionId, { runtime, status })
  }

  private removeExpired(now: number): void {
    for (const [sessionId, identity] of this.identities) {
      if (identity.expiresAt && Date.parse(identity.expiresAt) <= now) {
        this.identities.delete(sessionId)
        this.metadataStatuses.set(sessionId, { runtime: identity.runtime, status: 'expired' })
        this.addDiagnostic({ code: 'expired', sessionId, runtime: identity.runtime })
      }
    }
    const activeWorkflowIds = new Set([...this.identities.values()].map(identity => identity.workflowId))
    for (const workflowId of this.workflowDefinitions.keys()) if (!activeWorkflowIds.has(workflowId)) this.workflowDefinitions.delete(workflowId)
  }

  private addDiagnostic(diagnostic: WorkflowReaderDiagnostic): void {
    if (this.diagnostics.length < MAX_WORKFLOW_DIAGNOSTICS) this.diagnostics.push(diagnostic)
  }

  private overflow(): void {
    if (this.overflowed) return
    this.overflowed = true
    this.identities.clear()
    this.workflowDefinitions.clear()
    this.eventIds.clear()
    this.conflictedSessions.clear()
    this.conflictedWorkflows.clear()
    this.metadataStatuses.clear()
    this.orchestrationEvents.length = 0
    this.remainder = ''
    this.addDiagnostic({ code: 'overflow' })
  }
}

export function enrichSessionList<T extends { id: string; runtime?: 'codex' | 'claude'; workflow?: WorkflowIdentity; workflowMetadataStatus?: WorkflowMetadataStatus }>(reader: WorkflowIdentityReader | null | undefined, sessions: T[]): Array<T & { workflow?: WorkflowIdentity; workflowMetadataStatus?: WorkflowMetadataStatus }> {
  return reader ? sessions.map(session => reader.apply(session)) : sessions
}
