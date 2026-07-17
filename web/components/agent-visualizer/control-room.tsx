'use client'

import { useEffect, useMemo, useState } from 'react'
import { COLORS } from '@/lib/colors'
import { formatModelName, formatTokens } from '@/lib/utils'
import { groupSessionsByWorkflow, sessionStatus, shortSessionId, type SessionSummary } from '@/lib/session-summary'

function SessionCard({ session, onOpen, now }: { session: SessionSummary; onOpen: (id: string) => void; now: number }) {
  const status = sessionStatus(session)
  const elapsed = Math.max(0, Math.floor(((status === 'Inactive' ? session.lastActivityTime : now) - session.startTime) / 1000))
  const percent = session.tokens !== undefined && session.tokensMax
    ? Math.max(0, Math.min(100, Math.round(session.tokens / session.tokensMax * 100))) : undefined
  return (
    <article className="rounded-lg p-4 min-w-0" style={{ background: COLORS.holoBg03, border: `1px solid ${COLORS.holoBorder06}` }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm" style={{ color: COLORS.holoBright }}>{session.label}</h3>
          <p className="mt-1 text-[10px]" style={{ color: COLORS.textMuted }}>{shortSessionId(session.id)}</p>
        </div>
        <span
          className="rounded px-2 py-1 text-[10px]"
          title={status === 'Inactive' ? 'No file activity for five minutes; new activity will reactivate this session.' : undefined}
          aria-label={status === 'Inactive' ? 'Inactive: no file activity for five minutes; new activity will reactivate this session.' : status}
          style={{ color: status === 'Inactive' ? COLORS.textMuted : COLORS.complete, border: `1px solid ${COLORS.toggleBorder}` }}
        >{status}</span>
      </div>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
        <dt style={{ color: COLORS.textMuted }}>Runtime</dt><dd style={{ color: COLORS.holoBright }}>{session.runtime ? session.runtime[0].toUpperCase() + session.runtime.slice(1) : 'Unavailable'}</dd>
        <dt style={{ color: COLORS.textMuted }}>Model</dt><dd className="truncate" style={{ color: COLORS.holoBright }}>{session.model ? formatModelName(session.model) : 'Unavailable'}</dd>
        <dt style={{ color: COLORS.textMuted }}>Elapsed</dt><dd style={{ color: COLORS.holoBright }}>{Math.floor(elapsed / 60)}m {elapsed % 60}s</dd>
        <dt style={{ color: COLORS.textMuted }}>Activity</dt><dd style={{ color: COLORS.holoBright }}>{session.activity ?? 'No activity reported'}</dd>
        <dt style={{ color: COLORS.textMuted }}>Context</dt><dd style={{ color: COLORS.holoBright }}>{session.tokens === undefined ? 'Unavailable' : `${formatTokens(session.tokens)}${percent === undefined ? '' : ` (${percent}%)`}`}</dd>
        <dt style={{ color: COLORS.textMuted }}>Workspace</dt><dd className="truncate" title={session.workspace} style={{ color: COLORS.holoBright }}>{session.workspace ?? 'Unavailable'}</dd>
        <dt style={{ color: COLORS.textMuted }}>Workflow</dt><dd style={{ color: COLORS.holoBright }}>{session.workflowMetadataStatus === 'invalid' ? 'Invalid metadata' : session.workflowMetadataStatus === 'expired' ? 'Expired metadata' : session.workflow ? session.workflow.workflowName : 'Unavailable'}</dd>
      </dl>
      <button type="button" onClick={() => onOpen(session.id)} className="mt-4 w-full rounded px-3 py-2 text-xs" style={{ color: COLORS.holoBright, background: COLORS.toggleActive, border: `1px solid ${COLORS.toggleBorder}` }}>Open details</button>
    </article>
  )
}

function SessionGrid({ sessions, onOpen, now }: { sessions: SessionSummary[]; onOpen: (id: string) => void; now: number }) {
  return <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{sessions.map(session => <SessionCard key={session.id} session={session} onOpen={onOpen} now={now} />)}</div>
}

export function ControlRoom({ sessions, onOpen }: { sessions: SessionSummary[]; onOpen: (id: string) => void }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const grouped = useMemo(() => groupSessionsByWorkflow(sessions), [sessions])

  return (
    <main className="absolute inset-0 z-20 overflow-auto p-4 sm:p-8 font-mono" style={{ background: COLORS.void }}>
      <header className="mb-6">
        <h1 className="text-lg" style={{ color: COLORS.holoBright }}>Workspace control room</h1>
        <p className="mt-1 text-xs" style={{ color: COLORS.textMuted }}>{sessions.length} detected session{sessions.length === 1 ? '' : 's'}</p>
      </header>
      <div className="space-y-8">
        {grouped.workflows.map(({ workflow, sessions: workflowSessions }, workflowIndex) => {
          const counts = workflowSessions.reduce<Record<string, number>>((all, session) => {
            const status = sessionStatus(session)
            all[status] = (all[status] ?? 0) + 1
            return all
          }, {})
          return (
            <section key={workflow.workflowId} aria-labelledby={`workflow-${workflowIndex}`}>
              <header className="mb-3 min-w-0">
                <h2 id={`workflow-${workflowIndex}`} className="truncate text-sm" title={workflow.workflowName} style={{ color: COLORS.holoBright }}>Workflow: {workflow.workflowName}</h2>
                <p className="mt-1 truncate text-[10px]" title={workflow.workflowId} style={{ color: COLORS.textMuted }}>
                  {workflow.workflowId} · {workflowSessions.length} session{workflowSessions.length === 1 ? '' : 's'} · {Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(', ')}
                </p>
                <p className="mt-1 text-[10px]" style={{ color: COLORS.textMuted }}>Source: {workflow.workflowSource} · {workflow.provenance}</p>
                {workflow.workflowDescription ? <p className="mt-1 text-xs" style={{ color: COLORS.textMuted }}>{workflow.workflowDescription}</p> : null}
              </header>
              <SessionGrid sessions={workflowSessions} onOpen={onOpen} now={now} />
            </section>
          )
        })}
        {grouped.ungrouped.length > 0 ? (
          <section aria-labelledby="ungrouped-sessions">
            <header className="mb-3">
              <h2 id="ungrouped-sessions" className="text-sm" style={{ color: COLORS.holoBright }}>Ungrouped Sessions</h2>
              <p className="mt-1 text-[10px]" style={{ color: COLORS.textMuted }}>Missing, invalid, or expired workflow metadata is not grouped</p>
            </header>
            <SessionGrid sessions={grouped.ungrouped} onOpen={onOpen} now={now} />
          </section>
        ) : null}
      </div>
    </main>
  )
}
