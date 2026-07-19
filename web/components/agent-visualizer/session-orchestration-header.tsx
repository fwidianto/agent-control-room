'use client'

import { useMemo } from 'react'
import { COLORS } from '@/lib/colors'
import type { OrchestrationState } from '@/lib/orchestration-state'
import { sessionOrchestrationContext } from '@/lib/workflow-control-room'

const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300'

export function SessionOrchestrationHeader({ sessionId, state, availableSessionIds, onOpenSession, onOpenOverview }: {
  sessionId: string
  state: OrchestrationState
  availableSessionIds: ReadonlySet<string>
  onOpenSession: (id: string) => void
  onOpenOverview: () => void
}) {
  const context = useMemo(() => sessionOrchestrationContext(sessionId, state), [sessionId, state])
  const relation = (item: { name: string; sessionId?: string }) => item.sessionId && availableSessionIds.has(item.sessionId)
    ? <button type="button" className={`underline underline-offset-2 ${focus}`} onClick={() => onOpenSession(item.sessionId!)}>{item.name}</button>
    : item.name
  return <section aria-label="Selected session orchestration context" className="absolute left-3 right-3 top-14 z-20 max-h-[42vh] overflow-auto rounded-lg p-3 text-xs sm:left-4 sm:right-auto sm:w-[min(46rem,calc(100vw-2rem))]" style={{ background: COLORS.holoBg10, border: `1px solid ${COLORS.toggleBorder}`, backdropFilter: 'blur(14px)' }}>
    <nav aria-label="Agent relationship path" className="flex flex-wrap gap-1 text-[10px]" style={{ color: COLORS.textMuted }}>
      <button type="button" className={`underline underline-offset-2 ${focus}`} onClick={onOpenOverview}>Workflow Overview</button>
      {context.breadcrumb.map((item, index) => <span key={`${item.name}-${index}`}> &gt; {relation(item)}</span>)}
    </nav>
    <div className="mt-2 flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0"><p className="break-words text-[10px]" style={{ color: COLORS.textMuted }}>{context.workflowName}</p><h2 className="break-words text-sm" style={{ color: COLORS.holoBright }}>{context.agentName}{context.agentRole ? ` \u00b7 ${context.agentRole}` : ''}</h2></div>
      <span className="rounded px-2 py-1 text-[10px]" style={{ color: COLORS.holoBright, border: `1px solid ${COLORS.toggleBorder}` }}>{context.status}</span>
    </div>
    <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
      <dt style={{ color: COLORS.textMuted }}>Workflow</dt><dd className="break-words" style={{ color: COLORS.holoBright }}>{context.workflowName}</dd>
      <dt style={{ color: COLORS.textMuted }}>Session ID</dt><dd className="break-all" style={{ color: COLORS.holoBright }}>{context.sessionId}</dd>
      <dt style={{ color: COLORS.textMuted }}>Parent agent</dt><dd style={{ color: COLORS.holoBright }}>{context.parent ? relation(context.parent) : 'No explicit parent recorded'}</dd>
      <dt style={{ color: COLORS.textMuted }}>Child agents</dt><dd className="flex flex-wrap gap-x-2" style={{ color: COLORS.holoBright }}>{context.children.length ? context.children.map((child, index) => <span key={`${child.name}-${index}`}>{relation(child)}</span>) : 'No explicit child relationships recorded'}</dd>
      <dt style={{ color: COLORS.textMuted }}>Assignment</dt><dd className="break-words" style={{ color: COLORS.holoBright }}>{context.assignment}</dd>
      <dt style={{ color: COLORS.textMuted }}>Status</dt><dd style={{ color: COLORS.holoBright }}>{context.status}</dd>
    </dl>
  </section>
}
