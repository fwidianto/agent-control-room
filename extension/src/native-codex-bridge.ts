import { parseOrchestrationEvent, type OrchestrationEvent } from './orchestration-events'

const SOURCE = 'native-codex-rollout'
const MAX_SAFE_TEXT = 256
const MAX_NATIVE_EVENTS = 10_000
const MAX_NATIVE_THREADS = 256
const MAX_NATIVE_RECORDS_PER_THREAD = 512
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type NativeStatus = 'running' | 'completed'

interface NativeTurn {
  id: string
  startedAt?: string
  completedAt?: string
}

interface NativeCall {
  id: string
  name: 'spawn_agent' | 'wait_agent' | 'list_agents'
  timestamp: string
  taskName?: string
}

interface NativeSpawn {
  callId: string
  childId: string
  agentPath: string
  timestamp: string
}

interface NativeStatusObservation {
  callId: string
  agentPath: string
  status: NativeStatus
  timestamp: string
}

interface NativeThread {
  id: string
  createdAt?: string
  rootId?: string
  parentId?: string
  agentPath?: string
  nickname?: string
  agentRole?: string
  ownRecordsStarted: boolean
  triggerPending: boolean
  pendingTaskStarts: NativeTurn[]
  turns: Map<string, NativeTurn>
  calls: Map<string, NativeCall>
  spawns: Map<string, NativeSpawn>
  waits: Map<string, { startedAt: string; resumedAt?: string }>
  statuses: Map<string, NativeStatusObservation>
  retainedRecords: Set<string>
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function safeText(value: unknown, max = MAX_SAFE_TEXT): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
    ? value : undefined
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return undefined
  return new Date(value).toISOString()
}

function event(value: Record<string, unknown>): OrchestrationEvent | null {
  return parseOrchestrationEvent({ eventVersion: 1, source: SOURCE, ...value })
}

function label(thread: NativeThread | undefined, id: string): string {
  return thread?.agentPath ?? thread?.nickname ?? `Codex ${id.slice(0, 8)}`
}

/** Normalizes only structured native multi-agent metadata from rollout lines. */
export class NativeCodexBridge {
  private readonly threads = new Map<string, NativeThread>()
  private events: OrchestrationEvent[] = []
  private fingerprint = ''
  private revision = 0

  getEvents(): readonly OrchestrationEvent[] { return this.events }

  resetSession(sessionId: string): boolean {
    if (!this.threads.delete(sessionId)) return false
    return this.rebuild()
  }

  processLines(sessionId: string, lines: readonly string[]): boolean {
    let thread = this.threads.get(sessionId)
    if (!thread) {
      if (!THREAD_ID.test(sessionId) || this.threads.size >= MAX_NATIVE_THREADS) return false
      thread = {
        id: sessionId,
        ownRecordsStarted: false, triggerPending: false, pendingTaskStarts: [],
        turns: new Map(), calls: new Map(), spawns: new Map(), waits: new Map(), statuses: new Map(), retainedRecords: new Set(),
      }
      this.threads.set(sessionId, thread)
      this.revision++
    }

    const before = this.revision
    for (const line of lines) this.processLine(thread, line)
    if (this.revision === before) return false
    return this.rebuild()
  }

  private processLine(thread: NativeThread, line: string): void {
    let record: Record<string, unknown>
    try { record = JSON.parse(line) as Record<string, unknown> } catch { return }
    const payload = object(record.payload)
    const at = timestamp(record.timestamp)
    if (!payload || !at) return

    if (record.type === 'session_meta' && payload.id === thread.id) {
      if (!thread.createdAt) { thread.createdAt = at; this.revision++ }
      if (payload.thread_source === 'subagent') {
        const parentId = safeText(payload.parent_thread_id)
        const rootId = safeText(payload.session_id)
        const agentPath = safeText(payload.agent_path)
        const forkedFromId = safeText(payload.forked_from_id)
        const source = object(payload.source)
        const spawn = object(object(source?.subagent)?.thread_spawn)
        const nickname = safeText(payload.agent_nickname)
        const agentRole = safeText(payload.agent_role)
        if (!parentId || !rootId || !agentPath || !THREAD_ID.test(parentId) || !THREAD_ID.test(rootId)
          || forkedFromId !== parentId || spawn?.parent_thread_id !== parentId || spawn.agent_path !== agentPath
          || nickname !== safeText(spawn.agent_nickname) || agentRole !== safeText(spawn.agent_role)) return
        thread.parentId = parentId
        thread.rootId = rootId
        thread.agentPath = agentPath
        thread.nickname = nickname
        thread.agentRole = agentRole
        this.revision++
      } else {
        thread.rootId = thread.id
        thread.ownRecordsStarted = true
        this.revision++
      }
      return
    }

    if (record.type === 'event_msg' && payload.type === 'sub_agent_activity') {
      const childId = safeText(payload.agent_thread_id)
      const agentPath = safeText(payload.agent_path)
      const callId = safeText(payload.event_id)
      if (payload.kind !== 'started' || !childId || !THREAD_ID.test(childId) || !agentPath || !callId) return
      if (childId === thread.id) this.activate(thread, false)
      if (thread.ownRecordsStarted) this.setBounded(thread, 'spawn', thread.spawns, callId, { callId, childId, agentPath, timestamp: at })
      return
    }

    if (!thread.ownRecordsStarted && record.type === 'event_msg' && payload.type === 'task_started') {
      const turnId = safeText(payload.turn_id)
      if (turnId) {
        thread.pendingTaskStarts.push({ id: turnId, startedAt: at })
        if (thread.pendingTaskStarts.length > 32) thread.pendingTaskStarts.shift()
        this.revision++
      }
      return
    }
    if (!thread.ownRecordsStarted && record.type === 'inter_agent_communication_metadata' && payload.trigger_turn === true) {
      thread.triggerPending = true
      this.revision++
      return
    }
    if (!thread.ownRecordsStarted && thread.triggerPending && record.type === 'response_item'
      && payload.type === 'agent_message' && payload.recipient === thread.agentPath) {
      this.activate(thread)
      return
    }

    // Forked child rollouts contain copied parent history before their own start marker.
    if (!thread.ownRecordsStarted) return

    if (record.type === 'event_msg' && (payload.type === 'task_started' || payload.type === 'task_complete')) {
      const turnId = safeText(payload.turn_id)
      if (!turnId) return
      const turn = thread.turns.get(turnId) ?? { id: turnId }
      if (payload.type === 'task_started') turn.startedAt = at
      else turn.completedAt = at
      this.setBounded(thread, 'turn', thread.turns, turnId, turn)
      return
    }

    if (record.type !== 'response_item') return
    if (payload.type === 'function_call') {
      const callId = safeText(payload.call_id)
      const name = payload.name
      if (!callId || (name !== 'spawn_agent' && name !== 'wait_agent' && name !== 'list_agents')) return
      const call: NativeCall = { id: callId, name, timestamp: at }
      if (name === 'spawn_agent') {
        try { call.taskName = safeText(object(JSON.parse(String(payload.arguments)))?.task_name) } catch {}
      }
      this.setBounded(thread, 'call', thread.calls, callId, call)
      if (name === 'wait_agent') this.setBounded(thread, 'wait', thread.waits, callId, { startedAt: at })
      return
    }

    if (payload.type !== 'function_call_output') return
    const callId = safeText(payload.call_id)
    const call = callId ? thread.calls.get(callId) : undefined
    if (!call) return
    if (call.name === 'wait_agent') {
      const wait = thread.waits.get(call.id)
      if (wait) { wait.resumedAt = at; this.revision++ }
      return
    }
    if (call.name !== 'list_agents' || typeof payload.output !== 'string') return
    let output: Record<string, unknown> | null
    try { output = object(JSON.parse(payload.output)) } catch { return }
    if (!Array.isArray(output?.agents)) return
    for (const item of output.agents) {
      const agent = object(item)
      const agentPath = safeText(agent?.agent_name)
      const rawStatus = agent?.agent_status
      const completed = object(rawStatus)
      const status: NativeStatus | undefined = rawStatus === 'running' ? 'running'
        : completed && Object.prototype.hasOwnProperty.call(completed, 'completed') ? 'completed' : undefined
      if (agentPath && status) this.setBounded(thread, 'status', thread.statuses, `${call.id}:${agentPath}`, { callId: call.id, agentPath, status, timestamp: at })
    }
  }

  private activate(thread: NativeThread, promotePending = true): void {
    thread.ownRecordsStarted = true
    const ownStart = promotePending ? thread.pendingTaskStarts.at(-1) : undefined
    if (ownStart) this.setBounded(thread, 'turn', thread.turns, ownStart.id, ownStart)
    thread.pendingTaskStarts.length = 0
    thread.triggerPending = false
    this.revision++
  }

  private setBounded<T>(thread: NativeThread, category: string, map: Map<string, T>, key: string, value: T): void {
    const retainedKey = `${category}:${key}`
    if (!map.has(key) && thread.retainedRecords.size >= MAX_NATIVE_RECORDS_PER_THREAD) return
    thread.retainedRecords.add(retainedKey)
    map.set(key, value)
    this.revision++
  }

  private rebuild(): boolean {
    const childThreads = [...this.threads.values()].filter(thread => thread.parentId && thread.rootId)
    const roots = new Map<string, NativeThread[]>()
    for (const child of childThreads) {
      const children = roots.get(child.rootId!) ?? []
      children.push(child)
      roots.set(child.rootId!, children)
    }

    const next: OrchestrationEvent[] = []
    const emitted = new Set<string>()
    const push = (candidate: OrchestrationEvent | null) => {
      if (candidate && !emitted.has(candidate.eventId) && next.length < MAX_NATIVE_EVENTS) {
        emitted.add(candidate.eventId)
        next.push(candidate)
      }
    }
    for (const [rootId, children] of roots) {
      const root = this.threads.get(rootId)
      const createdAt = root?.createdAt ?? children.map(child => child.createdAt).filter(Boolean).sort()[0]
      if (!createdAt) continue
      const workflowName = `Codex ${rootId.slice(0, 8)}`
      const workflowId = rootId
      const workflowStartedAt = children.map(child => child.createdAt!).sort()[0] ?? createdAt
      push(event({ eventId: `codex-native:${rootId}:workflow-started`, type: 'workflow_started', timestamp: workflowStartedAt, workflowId, workflowName }))

      const memberIds = new Set<string>([rootId])
      for (const child of children) { memberIds.add(child.id); memberIds.add(child.parentId!) }
      for (const id of [...memberIds].sort()) {
        const member = this.threads.get(id)
        const memberAt = member?.createdAt ?? createdAt
        push(event({
          eventId: `codex-native:${rootId}:session:${id}`, type: 'workflow_session_registered', timestamp: memberAt,
          workflowId, workflowName, workflowCreatedAt: createdAt, workflowSource: SOURCE, sessionId: id, runtime: 'codex',
        }))
        push(event({
          eventId: `codex-native:${rootId}:agent:${id}`, type: 'agent_registered', timestamp: memberAt,
          workflowId, agentId: id, agentName: label(member, id), sessionId: id,
          ...(member?.agentRole ? { agentRole: member.agentRole } : {}),
        }))
      }

      for (const child of children) {
        push(event({
          eventId: `codex-native:${rootId}:delegation:${child.parentId}:${child.id}`, type: 'delegation_created',
          timestamp: child.createdAt!, workflowId, agentId: child.id, parentAgentId: child.parentId,
          sessionId: child.id, parentSessionId: child.parentId,
        }))
      }

      for (const owner of this.threads.values()) {
        for (const spawn of owner.spawns.values()) {
          if (!memberIds.has(owner.id) || !memberIds.has(spawn.childId)) continue
          const call = owner.calls.get(spawn.callId)
          if (!call?.taskName) continue
          push(event({
            eventId: `codex-native:${rootId}:assignment:${spawn.callId}`, type: 'assignment_created',
            timestamp: spawn.timestamp, workflowId, assignmentId: spawn.callId,
            assignmentTitle: call.taskName, agentId: spawn.childId,
          }))
        }

        if (!memberIds.has(owner.id)) continue
        const turns = [...owner.turns.values()].sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''))
        let returned = false
        for (const turn of turns) {
          if (turn.startedAt) {
            push(event({
              eventId: `codex-native:${rootId}:turn:${turn.id}:${returned ? 'resumed' : 'active'}`,
              type: returned ? 'agent_resumed' : 'agent_status_updated', timestamp: turn.startedAt,
              workflowId, agentId: owner.id, ...(returned ? {} : { status: 'active' }),
            }))
          }
          if (turn.completedAt) {
            push(event({
              eventId: `codex-native:${rootId}:turn:${turn.id}:returned`, type: 'agent_returned',
              timestamp: turn.completedAt, workflowId, agentId: owner.id,
            }))
            returned = true
          }
        }

        for (const [callId, wait] of owner.waits) {
          push(event({
            eventId: `codex-native:${rootId}:wait:${callId}:waiting`, type: 'agent_waiting',
            timestamp: wait.startedAt, workflowId, agentId: owner.id,
          }))
          if (wait.resumedAt) push(event({
            eventId: `codex-native:${rootId}:wait:${callId}:resumed`, type: 'agent_resumed',
            timestamp: wait.resumedAt, workflowId, agentId: owner.id,
          }))
        }

        for (const observed of owner.statuses.values()) {
          const agent = [...memberIds].map(id => this.threads.get(id)).find(item => item?.agentPath === observed.agentPath)
          if (!agent) continue
          push(event({
            eventId: `codex-native:${rootId}:status:${observed.callId}:${agent.id}:${observed.status}`,
            type: 'agent_status_updated', timestamp: observed.timestamp, workflowId, agentId: agent.id,
            status: observed.status === 'running' ? 'active' : 'completed',
          }))
        }
      }
    }

    next.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.eventId.localeCompare(b.eventId))
    const fingerprint = next.map(item => item.eventId).join('\n')
    if (fingerprint === this.fingerprint) return false
    this.fingerprint = fingerprint
    this.events = next
    return true
  }
}
