'use client'

import { useEffect, useMemo, useState } from 'react'
import { COLORS } from '@/lib/colors'
import type { AssignmentOrchestrationState, OrchestrationState } from '@/lib/orchestration-state'
import { orchestrationEntityKey } from '@/lib/orchestration-state'
import { formatModelName, formatTokens } from '@/lib/utils'
import { groupSessionsByWorkflow, sessionStatus, shortSessionId, type SessionSummary } from '@/lib/session-summary'
import {
  buildAgentForest, buildWorkflowTimeline, CONTROL_ROOM_GRAPH_LIMIT, CONTROL_ROOM_RENDER_LIMIT, filterWorkflowTimeline,
  latestAgentEdgeInteractions, limitAgentForest, partitionSessionActivity, workflowMetrics, type AgentEdgeInteraction, type AgentTreeNode, type SessionActivityEvent, type TimelineFilters,
  type WorkflowTimelineItem,
} from '@/lib/workflow-control-room'

const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300'
const noActivity: SessionActivityEvent[] = []

function elapsed(seconds?: number): string {
  return seconds === undefined ? 'Unavailable' : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(', ')
}

function SessionCard({ session, onOpen, now }: { session: SessionSummary; onOpen: (id: string) => void; now: number }) {
  const status = sessionStatus(session)
  const seconds = Math.max(0, Math.floor(((status === 'Inactive' ? session.lastActivityTime : now) - session.startTime) / 1000))
  const percent = session.tokens !== undefined && session.tokensMax
    ? Math.max(0, Math.min(100, Math.round(session.tokens / session.tokensMax * 100))) : undefined
  return (
    <article className="rounded-lg p-4 min-w-0" style={{ background: COLORS.holoBg03, border: `1px solid ${COLORS.holoBorder06}` }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm" title={session.label} style={{ color: COLORS.holoBright }}>{session.label}</h3>
          <p className="mt-1 text-[10px]" style={{ color: COLORS.textMuted }}>{shortSessionId(session.id)}</p>
        </div>
        <span className="rounded px-2 py-1 text-[10px]" aria-label={status} style={{ color: status === 'Inactive' ? COLORS.textMuted : COLORS.complete, border: `1px solid ${COLORS.toggleBorder}` }}>{status}</span>
      </div>
      {status === 'Inactive' ? <p className="mt-2 text-[10px]" style={{ color: COLORS.textMuted }}>No file activity for five minutes; new activity will reactivate this session.</p> : null}
      <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
        <dt style={{ color: COLORS.textMuted }}>Runtime</dt><dd style={{ color: COLORS.holoBright }}>{session.runtime ? session.runtime[0].toUpperCase() + session.runtime.slice(1) : 'Unavailable'}</dd>
        <dt style={{ color: COLORS.textMuted }}>Model</dt><dd className="truncate" title={session.model} style={{ color: COLORS.holoBright }}>{session.model ? formatModelName(session.model) : 'Unavailable'}</dd>
        <dt style={{ color: COLORS.textMuted }}>Elapsed</dt><dd style={{ color: COLORS.holoBright }}>{elapsed(seconds)}</dd>
        <dt style={{ color: COLORS.textMuted }}>Activity</dt><dd className="break-words" style={{ color: COLORS.holoBright }}>{session.activity ?? 'No activity reported'}</dd>
        <dt style={{ color: COLORS.textMuted }}>Context</dt><dd style={{ color: COLORS.holoBright }}>{session.tokens === undefined ? 'Unavailable' : `${formatTokens(session.tokens)}${percent === undefined ? '' : ` (${percent}%)`}`}</dd>
        <dt style={{ color: COLORS.textMuted }}>Workspace</dt><dd className="truncate" title={session.workspace} style={{ color: COLORS.holoBright }}>{session.workspace ?? 'Unavailable'}</dd>
        <dt style={{ color: COLORS.textMuted }}>Workflow</dt><dd className="break-words" style={{ color: COLORS.holoBright }}>{session.workflowMetadataStatus === 'invalid' ? 'Invalid metadata' : session.workflowMetadataStatus === 'expired' ? 'Expired metadata' : session.workflow ? session.workflow.workflowName : 'Unavailable'}</dd>
      </dl>
      <button type="button" onClick={() => onOpen(session.id)} className={`mt-4 w-full rounded px-3 py-2 text-xs ${focus}`} style={{ color: COLORS.holoBright, background: COLORS.toggleActive, border: `1px solid ${COLORS.toggleBorder}` }}>Open details</button>
    </article>
  )
}

function SessionGrid({ sessions, onOpen, now }: { sessions: SessionSummary[]; onOpen: (id: string) => void; now: number }) {
  return <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{sessions.map(session => <SessionCard key={session.id} session={session} onOpen={onOpen} now={now} />)}</div>
}

function statusColor(status?: string): string {
  if (status === 'failed' || status === 'blocked') return COLORS.error
  if (status === 'completed' || status === 'returned') return COLORS.complete
  if (status === 'waiting') return COLORS.waiting_permission
  return COLORS.holoBright
}

function AgentNodeCard({ node, workflowId, state, assignment, sessions, now, onOpen }: {
  node: AgentTreeNode; workflowId: string; state: OrchestrationState; assignment?: AssignmentOrchestrationState; sessions: Map<string, SessionSummary>; now: number; onOpen: (id: string) => void
}) {
  const agent = node.agent
  const session = agent.sessionId ? sessions.get(agent.sessionId) : undefined
  const isChild = state.delegations.has(orchestrationEntityKey(workflowId, agent.agentId))
  const runtime = session?.runtime === 'codex' ? 'Codex' : session?.runtime === 'claude' ? 'Claude' : 'Agent'
  const name = agent.agentName ?? `${runtime} ${shortSessionId(agent.sessionId ?? agent.agentId)}`
  const seconds = session ? Math.max(0, Math.floor(((session.status === 'completed' ? session.lastActivityTime : now) - session.startTime) / 1000)) : undefined
  const context = session?.tokens === undefined ? 'Unavailable' : `${formatTokens(session.tokens)}${session.tokensMax ? ` / ${formatTokens(session.tokensMax)}` : ''}`
  const relationship = isChild && node.children.length ? 'Parent and child relationships recorded' : isChild ? 'Parent relationship recorded' : node.children.length ? 'Child relationships recorded' : 'No explicit relationship recorded'
  return <article className="agent-node min-w-0 rounded-xl p-4 text-left" style={{ background: COLORS.glassBg, border: `1px solid ${statusColor(agent.status)}55`, boxShadow: `0 0 24px ${statusColor(agent.status)}18` }}>
    <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="break-words text-sm" style={{ color: COLORS.holoBright }}>{name}{agent.agentRole ? ` \u00b7 ${agent.agentRole}` : ''}</h3><p className="mt-1 text-[10px]" style={{ color: COLORS.textMuted }}>{relationship}{agent.sessionId ? ` \u00b7 ${shortSessionId(agent.sessionId)}` : ''}</p></div><span className="rounded px-2 py-1 text-[10px]" style={{ color: statusColor(agent.status), border: `1px solid ${statusColor(agent.status)}55` }}>{agent.status ?? 'unknown'}</span></div>
    <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-[10px]">
      <dt style={{ color: COLORS.textMuted }}>Assignment</dt><dd className="break-words" style={{ color: COLORS.holoBright }}>{assignment?.assignmentTitle ?? assignment?.assignmentId ?? 'Unavailable'}</dd>
      <dt style={{ color: COLORS.textMuted }}>Latest operation</dt><dd className="break-words" style={{ color: COLORS.holoBright }}>{session?.activity ?? 'No operation reported'}</dd>
      <dt style={{ color: COLORS.textMuted }}>Context</dt><dd style={{ color: COLORS.holoBright }}>{context}</dd>
      <dt style={{ color: COLORS.textMuted }}>Activity time</dt><dd style={{ color: COLORS.holoBright }}>{elapsed(seconds)}</dd>
    </dl>
    {session ? <button type="button" onClick={() => onOpen(session.id)} className={`mt-4 w-full rounded px-3 py-2 text-[10px] ${focus}`} style={{ color: COLORS.holoBright, background: COLORS.toggleActive, border: `1px solid ${COLORS.toggleBorder}` }}>Open agent detail</button> : <p className="mt-4 text-[10px]" style={{ color: COLORS.textMuted }}>Session detail unavailable</p>}
  </article>
}

function AgentTopologyBranch({ node, workflowId, state, assignments, interactions, sessions, now, onOpen, root = false }: {
  node: AgentTreeNode; workflowId: string; state: OrchestrationState; assignments: Map<string, AssignmentOrchestrationState>; interactions: Map<string, AgentEdgeInteraction>; sessions: Map<string, SessionSummary>; now: number; onOpen: (id: string) => void; root?: boolean
}) {
  const interaction = root ? undefined : interactions.get(node.agent.agentId)
  const live = interaction && now >= interaction.timestamp && now - interaction.timestamp <= 10_000
  return <li className="topology-branch">
    {!root ? <div className={`edge-signal ${live ? `edge-${interaction.direction}` : ''}`} aria-label={live ? interaction.label : undefined}>{live ? <><span className="edge-dot" /><span className="edge-label">{interaction.label}</span></> : null}</div> : null}
    <AgentNodeCard node={node} workflowId={workflowId} state={state} assignment={assignments.get(node.agent.agentId)} sessions={sessions} now={now} onOpen={onOpen} />
    {node.children.length ? <ul>{node.children.map(child => <AgentTopologyBranch key={child.agent.agentId} node={child} workflowId={workflowId} state={state} assignments={assignments} interactions={interactions} sessions={sessions} now={now} onOpen={onOpen} />)}</ul> : null}
  </li>
}

function WorkflowGraph({ workflowId, state, sessions, now, onOpen }: { workflowId: string; state: OrchestrationState; sessions: SessionSummary[]; now: number; onOpen: (id: string) => void }) {
  const fullForest = useMemo(() => buildAgentForest(workflowId, state), [workflowId, state])
  const roots = useMemo(() => limitAgentForest(fullForest.roots, CONTROL_ROOM_GRAPH_LIMIT), [fullForest.roots])
  const sessionMap = useMemo(() => new Map(sessions.map(session => [session.id, session])), [sessions])
  const assignmentByAgent = useMemo(() => {
    const indexed = new Map<string, AssignmentOrchestrationState>()
    for (const assignment of state.assignments.values()) if (assignment.workflowId === workflowId && assignment.agentId) {
      const current = indexed.get(assignment.agentId)
      if (!current || assignment.status === 'active' || current.status !== 'active') indexed.set(assignment.agentId, assignment)
    }
    return indexed
  }, [workflowId, state])
  const interactions = useMemo(() => latestAgentEdgeInteractions(workflowId, state), [workflowId, state])
  const agentCount = useMemo(() => [...state.agents.values()].filter(agent => agent.workflowId === workflowId).length, [workflowId, state])
  if (!roots.length) return <p className="text-xs" style={{ color: COLORS.textMuted }}>No agents explicitly registered.</p>
  return <section aria-label="Live agent interaction graph" className="topology overflow-x-auto rounded-xl px-2 py-6" style={{ background: COLORS.holoBg03, border: `1px solid ${COLORS.holoBorder10}` }}>
    <p className="mb-4 text-center text-[10px] uppercase tracking-[0.2em]" style={{ color: COLORS.textMuted }}>{fullForest.hierarchical ? 'Explicit parent-child relationships' : 'Registered agents · no explicit hierarchy recorded'}</p>
    <ul className="topology-roots">{roots.map(node => <AgentTopologyBranch key={node.agent.agentId} node={node} workflowId={workflowId} state={state} assignments={assignmentByAgent} interactions={interactions} sessions={sessionMap} now={now} onOpen={onOpen} root />)}</ul>
    {agentCount > CONTROL_ROOM_GRAPH_LIMIT ? <p className="mt-4 text-center text-[10px]" style={{ color: COLORS.textMuted }}>Showing {CONTROL_ROOM_GRAPH_LIMIT} of {agentCount} registered agents.</p> : null}
    <style jsx global>{`
      .topology ul{display:flex;justify-content:center;position:relative;padding-top:2rem}.topology-roots{gap:1rem;padding-top:0!important}.topology-branch{list-style:none;position:relative;padding:2rem .5rem 0;text-align:center}.topology-roots>.topology-branch{padding-top:0}.topology-branch::before,.topology-branch::after{content:'';position:absolute;top:0;width:50%;height:2rem;border-top:1px solid rgba(102,204,255,.3)}.topology-branch::before{right:50%}.topology-branch::after{left:50%;border-left:1px solid rgba(102,204,255,.3)}.topology-branch:only-child::before,.topology-branch:only-child::after{display:none}.topology-branch:first-child::before,.topology-branch:last-child::after{border:0}.topology-branch:last-child::before{border-right:1px solid rgba(102,204,255,.3);border-radius:0 .5rem 0 0}.topology-branch:first-child::after{border-radius:.5rem 0 0 0}.topology-roots>.topology-branch::before,.topology-roots>.topology-branch::after{display:none}.topology-branch>ul::before{content:'';position:absolute;top:0;left:50%;height:2rem;border-left:1px solid rgba(102,204,255,.3)}.agent-node{width:min(18rem,calc(100vw - 3rem));position:relative;z-index:2}.edge-signal{position:absolute;z-index:3;top:0;left:50%;height:2rem;width:2px;transform:translateX(-50%)}.edge-signal.edge-pulse{background:#ffaa33;box-shadow:0 0 12px #ffaa33;animation:pulse 1s ease-in-out infinite}.edge-dot{position:absolute;left:-3px;width:8px;height:8px;border-radius:999px;background:#66ffaa;box-shadow:0 0 12px #66ffaa}.edge-out .edge-dot{animation:down 1.2s linear infinite}.edge-in .edge-dot{animation:up 1.2s linear infinite}.edge-label{position:absolute;left:.5rem;top:.4rem;white-space:nowrap;color:#aaeeff;font-size:9px;background:#050510;padding:1px 4px;border-radius:4px}.edge-pulse .edge-label{left:.5rem}.edge-pulse .edge-dot{display:none}@keyframes down{from{top:-4px}to{top:28px}}@keyframes up{from{top:28px}to{top:-4px}}@keyframes pulse{50%{opacity:.35}}
      @media(max-width:640px){.topology ul{display:block;padding-top:1.5rem}.topology-branch{padding:1.5rem 0 0}.topology-branch::before,.topology-branch::after{display:none}.topology-branch>ul::before{height:1.5rem}.edge-signal{height:1.5rem}.edge-label{top:.1rem}.edge-out .edge-dot{animation:down-mobile 1.2s linear infinite}.edge-in .edge-dot{animation:up-mobile 1.2s linear infinite}@keyframes down-mobile{from{top:-4px}to{top:20px}}@keyframes up-mobile{from{top:20px}to{top:-4px}}}
    `}</style>
  </section>
}

function Filter({ label, value, values, onChange }: { label: string; value?: string; values: string[]; onChange: (value?: string) => void }) {
  return <label className="min-w-0 text-[10px]" style={{ color: COLORS.textMuted }}>{label}<select value={value ?? ''} onChange={event => onChange(event.target.value || undefined)} className={`mt-1 block w-full rounded px-2 py-1 ${focus}`} style={{ background: COLORS.holoBg10, color: COLORS.holoBright, border: `1px solid ${COLORS.toggleBorder}` }}><option value="">All</option>{values.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
}

function unique(items: WorkflowTimelineItem[], key: 'agentId' | 'sessionId' | 'assignmentId' | 'eventType'): string[] {
  return [...new Set(items.map(item => item[key]).filter((value): value is string => Boolean(value)))].sort()
}

function WorkflowTimeline({ items, onOpen }: { items: WorkflowTimelineItem[]; onOpen: (id: string) => void }) {
  const [filters, setFilters] = useState<TimelineFilters>({})
  const filtered = useMemo(() => filterWorkflowTimeline(items, filters), [items, filters])
  const options = useMemo(() => ({ agent: unique(items, 'agentId'), session: unique(items, 'sessionId'), assignment: unique(items, 'assignmentId'), event: unique(items, 'eventType') }), [items])
  const visible = filtered.slice(-CONTROL_ROOM_RENDER_LIMIT)
  const update = (key: keyof TimelineFilters, value?: string) => setFilters(current => ({ ...current, [key]: value }))
  return <div>
    <fieldset><legend className="text-xs" style={{ color: COLORS.holoBright }}>Timeline filters</legend><div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      <Filter label="Agent" value={filters.agentId} values={options.agent} onChange={value => update('agentId', value)} />
      <Filter label="Session" value={filters.sessionId} values={options.session} onChange={value => update('sessionId', value)} />
      <Filter label="Assignment" value={filters.assignmentId} values={options.assignment} onChange={value => update('assignmentId', value)} />
      <Filter label="Event type" value={filters.eventType} values={options.event} onChange={value => update('eventType', value)} />
    </div></fieldset>
    <p className="mt-3 text-[10px]" style={{ color: COLORS.textMuted }}>{filtered.length > visible.length ? `Showing latest ${visible.length} of ${filtered.length} matching events` : `${visible.length} matching event${visible.length === 1 ? '' : 's'}`}</p>
    {visible.length ? <ol className="mt-2 space-y-2" aria-label="Combined workflow timeline">{visible.map(item => <li key={item.id} className="grid gap-1 rounded p-2 text-[10px] sm:grid-cols-[10rem_1fr]" style={{ background: COLORS.holoBg03, border: `1px solid ${COLORS.holoBorder06}` }}>
      <time dateTime={new Date(item.timestamp).toISOString()} style={{ color: COLORS.textMuted }}>{new Date(item.timestamp).toLocaleString()}</time>
      <div className="min-w-0"><p className="break-words" style={{ color: COLORS.holoBright }}>{item.label}</p><p className="mt-1 break-words" style={{ color: COLORS.textMuted }}>Source: {item.source}{item.agentName || item.agentId ? ` · Agent: ${item.agentName ?? item.agentId}` : ''}{item.assignmentId ? ` · Assignment: ${item.assignmentId}` : ''}{item.sessionId ? <> · <button type="button" onClick={() => onOpen(item.sessionId!)} className={`underline ${focus}`}>Session {shortSessionId(item.sessionId)}</button></> : null}</p></div>
    </li>)}</ol> : <p className="mt-2 text-xs" style={{ color: COLORS.textMuted }}>No matching events.</p>}
  </div>
}

function WorkflowSection({ workflowId, workflowName, sessions, state, activity, onOpen, now, index }: {
  workflowId: string; workflowName: string; sessions: SessionSummary[]; state: OrchestrationState; activity: SessionActivityEvent[]; onOpen: (id: string) => void; now: number; index: number
}) {
  const metrics = useMemo(() => workflowMetrics(workflowId, state, sessions, now), [workflowId, state, sessions, now])
  const timeline = useMemo(() => buildWorkflowTimeline(workflowId, state, activity), [workflowId, state, activity])
  const assignments = useMemo(() => [...state.assignments.values()].filter(item => item.workflowId === workflowId), [workflowId, state])
  const identity = sessions[0]?.workflow
  return <section aria-labelledby={`workflow-${index}`} className="rounded-lg p-4 sm:p-5" style={{ border: `1px solid ${COLORS.holoBorder10}`, background: COLORS.holoBg03 }}>
    <header className="min-w-0"><div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><h2 id={`workflow-${index}`} className="truncate text-sm" title={workflowName} style={{ color: COLORS.holoBright }}>Workflow: {workflowName}</h2><p className="mt-1 truncate text-[10px]" title={workflowId} style={{ color: COLORS.textMuted }}>{workflowId}</p></div><span className="rounded px-2 py-1 text-[10px]" style={{ color: COLORS.holoBright, border: `1px solid ${COLORS.toggleBorder}` }}>{metrics.status}</span></div>
      <p className="mt-2 text-[10px]" style={{ color: COLORS.textMuted }}>Source: {identity?.workflowSource ?? state.workflows.get(workflowId)?.source ?? 'Unavailable'} · {identity?.provenance ?? 'Explicit orchestration event'}</p>
    </header>
    <dl className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3 lg:grid-cols-6">
      {([['Elapsed', elapsed(metrics.elapsedSeconds)], ['Sessions', metrics.sessionCount], ['Agents', metrics.agentCount], ['Context', metrics.tokens === undefined ? 'Unavailable' : formatTokens(metrics.tokens)], ['Assignments', `${metrics.completedAssignments}/${metrics.assignmentCount} completed`], ['Agent states', formatCounts(metrics.counts.agents)], ['Assignment states', formatCounts(metrics.counts.assignments)], ['Session states', formatCounts(metrics.counts.sessions)]] as const).map(([label, value]) => <div key={label} className="min-w-0 rounded p-2" style={{ background: COLORS.holoBg05 }}><dt style={{ color: COLORS.textMuted }}>{label}</dt><dd className="mt-1 break-words" style={{ color: COLORS.holoBright }}>{value}</dd></div>)}
    </dl>
    <section className="mt-5" aria-labelledby={`agents-${index}`}><h3 id={`agents-${index}`} className="mb-3 text-xs" style={{ color: COLORS.holoBright }}>Live interaction graph</h3><WorkflowGraph workflowId={workflowId} state={state} sessions={sessions} now={now} onOpen={onOpen} /></section>
    <details className="mt-5 rounded-lg p-3" style={{ border: `1px solid ${COLORS.holoBorder10}` }}><summary className={`cursor-pointer text-xs ${focus}`} style={{ color: COLORS.holoBright }}>Assignments</summary><div className="mt-3">{assignments.length ? <ul className="space-y-2 text-xs">{assignments.map(item => <li key={item.assignmentId}><span style={{ color: COLORS.holoBright }}>{item.assignmentTitle ?? item.assignmentId}</span><span style={{ color: COLORS.textMuted }}> · {item.status ?? 'unknown'}{item.progressPercent !== undefined ? ` · ${item.progressPercent}%` : ''}{item.agentId ? ` · Agent ${item.agentId}` : ''}{item.dependencyIds.length ? ` · Depends on ${item.dependencyIds.join(', ')}` : ''}</span>{item.reason ? <p style={{ color: COLORS.textMuted }}>Reason: {item.reason}</p> : null}</li>)}</ul> : <p className="text-xs" style={{ color: COLORS.textMuted }}>No assignments explicitly recorded.</p>}</div></details>
    <details className="mt-3 rounded-lg p-3" style={{ border: `1px solid ${COLORS.holoBorder10}` }}><summary id={`timeline-${index}`} className={`cursor-pointer text-xs ${focus}`} style={{ color: COLORS.holoBright }}>Combined timeline</summary><div className="mt-3"><WorkflowTimeline items={timeline} onOpen={onOpen} /></div></details>
    <details className="mt-3 rounded-lg p-3" style={{ border: `1px solid ${COLORS.holoBorder10}` }}><summary id={`sessions-${index}`} className={`cursor-pointer text-xs ${focus}`} style={{ color: COLORS.holoBright }}>Session cards</summary><div className="mt-3">{sessions.length ? <SessionGrid sessions={sessions} onOpen={onOpen} now={now} /> : <p className="text-xs" style={{ color: COLORS.textMuted }}>No sessions explicitly registered.</p>}</div></details>
  </section>
}

export function ControlRoom({ sessions, orchestrationState, sessionActivity, onOpen }: { sessions: SessionSummary[]; orchestrationState: OrchestrationState; sessionActivity: SessionActivityEvent[]; onOpen: (id: string) => void }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  const grouped = useMemo(() => groupSessionsByWorkflow(sessions), [sessions])
  const workflows = useMemo(() => {
    const sections = new Map(grouped.workflows.map(group => [group.workflow.workflowId, { workflowId: group.workflow.workflowId, workflowName: group.workflow.workflowName, sessions: group.sessions }]))
    for (const workflow of orchestrationState.workflows.values()) if (!sections.has(workflow.workflowId)) sections.set(workflow.workflowId, { workflowId: workflow.workflowId, workflowName: workflow.workflowName ?? workflow.workflowId, sessions: [] })
    return [...sections.values()]
  }, [grouped.workflows, orchestrationState])
  const activityByWorkflow = useMemo(() => {
    const memberships = new Map([...orchestrationState.memberships].map(([sessionId, membership]) => [sessionId, membership.workflowId]))
    for (const session of sessions) if (session.workflow) memberships.set(session.id, session.workflow.workflowId)
    return partitionSessionActivity(sessionActivity, memberships)
  }, [orchestrationState.memberships, sessionActivity, sessions])
  return <main className="absolute inset-0 z-20 overflow-auto p-4 sm:p-8 font-mono" style={{ background: COLORS.void }}>
    <header className="mb-6"><h1 className="text-lg" style={{ color: COLORS.holoBright }}>Workspace control room</h1><p className="mt-1 text-xs" style={{ color: COLORS.textMuted }}>{workflows.length} workflow{workflows.length === 1 ? '' : 's'} · {sessions.length} detected session{sessions.length === 1 ? '' : 's'}</p></header>
    <div className="space-y-8">{workflows.map((workflow, index) => <WorkflowSection key={workflow.workflowId} workflowId={workflow.workflowId} workflowName={workflow.workflowName} sessions={workflow.sessions} state={orchestrationState} activity={activityByWorkflow.get(workflow.workflowId) ?? noActivity} onOpen={onOpen} now={now} index={index} />)}
      {grouped.ungrouped.length ? <section aria-labelledby="ungrouped-sessions"><header className="mb-3"><h2 id="ungrouped-sessions" className="text-sm" style={{ color: COLORS.holoBright }}>Ungrouped Sessions</h2><p className="mt-1 text-[10px]" style={{ color: COLORS.textMuted }}>Missing, invalid, or expired workflow metadata is not grouped</p></header><SessionGrid sessions={grouped.ungrouped} onOpen={onOpen} now={now} /></section> : null}
    </div>
  </main>
}
