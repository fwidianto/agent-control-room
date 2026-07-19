'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OrchestrationState } from '@/lib/orchestration-state'
import { orchestrationEntityKey } from '@/lib/orchestration-state'
import { buildWorkflowCanvasModel, CONTROL_ROOM_GRAPH_LIMIT, type SessionActivityEvent } from '@/lib/workflow-control-room'
import type { SessionSummary } from '@/lib/session-summary'
import { createEmptyState } from '@/hooks/simulation/types'
import { AgentCanvas } from './canvas'
import { COLORS } from '@/lib/colors'
import { installFullscreenMode } from '@/lib/fullscreen-mode'

type CameraCommand = { id: number; type: 'fit' | 'recenter' | 'zoom-in' | 'zoom-out' | 'reset' }

export function WorkflowTopologyCanvas({ workflowId, state, sessions, activity, now, onOpen, secondaryPanelIds }: {
  workflowId: string
  state: OrchestrationState
  sessions: SessionSummary[]
  activity: SessionActivityEvent[]
  now: number
  onOpen: (id: string) => void
  secondaryPanelIds: { assignments: string; timeline: string; sessions: string }
}) {
  const baseModel = useMemo(() => buildWorkflowCanvasModel(workflowId, state, sessions, activity), [workflowId, state, sessions, activity])
  const model = useMemo(() => ({
    ...baseModel,
    agents: new Map([...baseModel.agents].map(([id, agent]) => [id, {
      ...agent,
      timeAlive: agent.elapsedKnown && agent.spawnTime ? Math.max(0, (agent.completeTime ?? now / 1000) - agent.spawnTime) : 0,
    }])),
    signals: baseModel.signals.filter(signal => now >= signal.timestamp && now - signal.timestamp <= 10_000),
  }), [baseModel, now])
  const simulation = useMemo(() => createEmptyState({ agents: model.agents, edges: model.edges, isPlaying: true, currentTime: now / 1000 }), [model, now])
  const simulationRef = useRef(simulation)
  simulationRef.current = simulation
  const [hoveredAgentId, setHoveredAgentId] = useState<string | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [cameraCommand, setCameraCommand] = useState<CameraCommand>()
  const commandIdRef = useRef(0)
  const scrollRef = useRef(0)
  const targetPanelRef = useRef<string | undefined>(undefined)
  const enterButtonRef = useRef<HTMLButtonElement>(null)
  const exitButtonRef = useRef<HTMLButtonElement>(null)
  const fullscreenRef = useRef<HTMLElement>(null)
  const sessionByAgent = useMemo(() => new Map([...state.agents.values()].filter(agent => agent.workflowId === workflowId && agent.sessionId).map(agent => [agent.agentId, agent.sessionId!])), [workflowId, state])
  const selectAgent = useCallback((agentId: string | null) => setSelectedAgentId(agentId), [])
  const selected = selectedAgentId ? model.agents.get(selectedAgentId) : undefined
  const selectedSessionId = selectedAgentId ? sessionByAgent.get(selectedAgentId) : undefined
  const selectedSession = selectedSessionId ? sessions.find(session => session.id === selectedSessionId) : undefined
  const selectedActivity = selectedSessionId ? activity.filter(event => event.sessionId === selectedSessionId).slice(-8).reverse() : []
  const parent = selected?.parentId ? model.agents.get(selected.parentId) : undefined
  const recordedParent = selected?.recordedParentId ? state.agents.get(orchestrationEntityKey(workflowId, selected.recordedParentId)) : undefined
  const children = selected ? [...model.agents.values()].filter(agent => agent.parentId === selected.id) : []
  const recordedChildCount = selected ? [...state.delegations.values()].filter(delegation => delegation.workflowId === workflowId && delegation.parentAgentId === selected.id).length : 0

  const runCameraCommand = useCallback((type: CameraCommand['type']) => setCameraCommand({ id: ++commandIdRef.current, type }), [])
  const enterFullscreen = useCallback(() => {
    scrollRef.current = window.scrollY
    setFullscreen(true)
  }, [])
  const exitFullscreen = useCallback((panelId?: string) => {
    targetPanelRef.current = panelId
    setFullscreen(false)
  }, [])

  useEffect(() => {
    if (!fullscreen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') exitFullscreen()
      if (event.key !== 'Tab') return
      const focusable = [...(fullscreenRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])') ?? [])]
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    const cleanup = installFullscreenMode(window, document.body.style, onKeyDown, () => {
      exitButtonRef.current?.focus()
      runCameraCommand('fit')
    })
    return () => {
      cleanup()
      const targetPanel = targetPanelRef.current
      targetPanelRef.current = undefined
      requestAnimationFrame(() => {
        if (targetPanel) {
          const panel = document.getElementById(targetPanel)
          panel?.scrollIntoView({ block: 'start' })
          panel?.querySelector<HTMLElement>('summary')?.focus()
        }
        else {
          window.scrollTo({ top: scrollRef.current })
          enterButtonRef.current?.focus()
        }
      })
    }
  }, [exitFullscreen, fullscreen, runCameraCommand])

  return <section ref={fullscreenRef} role={fullscreen ? 'dialog' : undefined} aria-modal={fullscreen || undefined} aria-label={fullscreen ? 'Fullscreen live agent interaction canvas' : 'Animated live agent interaction canvas'} className={fullscreen ? 'fixed inset-0 z-[100] h-dvh min-h-0 w-screen overflow-hidden' : 'relative h-[min(68vh,680px)] min-h-[480px] overflow-hidden rounded-xl'} style={{ border: `1px solid ${COLORS.holoBorder10}`, background: COLORS.void }}>
    <div className="absolute left-3 right-3 top-3 z-20 flex flex-wrap items-center justify-between gap-2 [&_button]:focus-visible:outline-2 [&_button]:focus-visible:outline-offset-2 [&_button]:focus-visible:outline-cyan-300" aria-label="Canvas controls">
      <div className="flex flex-wrap items-center gap-1 rounded-lg p-1 text-[10px]" style={{ background: `${COLORS.panelBg}e8`, border: `1px solid ${COLORS.holoBorder10}` }}>
        <span className="px-2" style={{ color: COLORS.holoBright }}>{fullscreen ? 'Fullscreen interaction mode' : 'Live interaction canvas'}</span>
        <button type="button" onClick={() => runCameraCommand('fit')} className="rounded px-2 py-1" title="Fit all agents">Fit all</button>
        <button type="button" onClick={() => runCameraCommand('recenter')} className="rounded px-2 py-1" title="Recenter graph">Recenter</button>
        <button type="button" onClick={() => runCameraCommand('zoom-in')} className="rounded px-2 py-1" aria-label="Zoom in">+</button>
        <button type="button" onClick={() => runCameraCommand('zoom-out')} className="rounded px-2 py-1" aria-label="Zoom out">{`\u2212`}</button>
        <button type="button" onClick={() => runCameraCommand('reset')} className="rounded px-2 py-1">Reset zoom</button>
      </div>
      {fullscreen ? <div className="flex items-start gap-2"><details className="rounded-lg p-1 text-[10px]" style={{ background: `${COLORS.panelBg}e8`, border: `1px solid ${COLORS.holoBorder10}` }}><summary className="cursor-pointer px-2 py-1">Secondary panels</summary><div className="mt-1 grid gap-1"><button type="button" onClick={() => exitFullscreen(secondaryPanelIds.assignments)} className="rounded px-2 py-1 text-left">Assignments</button><button type="button" onClick={() => exitFullscreen(secondaryPanelIds.timeline)} className="rounded px-2 py-1 text-left">Combined timeline</button><button type="button" onClick={() => exitFullscreen(secondaryPanelIds.sessions)} className="rounded px-2 py-1 text-left">Session cards</button></div></details><button ref={exitButtonRef} type="button" onClick={() => exitFullscreen()} className="rounded-lg px-3 py-2 text-[10px]" style={{ background: COLORS.toggleActive, border: `1px solid ${COLORS.toggleBorder}` }}>Exit fullscreen</button></div> : <button ref={enterButtonRef} type="button" onClick={enterFullscreen} className="rounded-lg px-3 py-2 text-[10px]" style={{ background: COLORS.toggleActive, border: `1px solid ${COLORS.toggleBorder}` }}>Fullscreen canvas</button>}
    </div>
    <AgentCanvas simulationRef={simulationRef} selectedAgentId={selectedAgentId} hoveredAgentId={hoveredAgentId} showStats={false} showHexGrid edgeSignals={model.signals} showOperationalLabels zoomToFitTrigger={model.agents.size} cameraCommand={cameraCommand} autoFitOnResize pauseAutoFit={Boolean(selected)} onAgentClick={selectAgent} onAgentHover={setHoveredAgentId} onAgentDrag={() => {}} onContextMenu={() => {}} />
    <ul className="sr-only">{[...model.agents.values()].map(agent => <li key={agent.id}><button type="button" onClick={() => selectAgent(agent.id)}>{agent.name}: {agent.statusLabel ?? agent.state}. Open agent details beside graph.</button></li>)}</ul>
    {selected ? <aside aria-label={`${selected.name} details`} className={`absolute inset-x-3 bottom-3 max-h-[42%] overflow-auto rounded-xl p-4 text-xs shadow-2xl sm:inset-x-auto sm:bottom-3 sm:right-3 sm:max-h-none sm:w-80 ${fullscreen ? 'sm:top-16' : 'sm:top-3'}`} style={{ color: COLORS.holoBright, background: `${COLORS.panelBg}f2`, border: `1px solid ${COLORS.holoBorder10}` }}>
      <div className="flex items-start justify-between gap-3"><div><h4 className="text-sm">{selected.name}</h4><p className="mt-1 text-[10px]" style={{ color: COLORS.textMuted }}>{selected.statusLabel ?? 'Unknown'} {`\u00b7`} {selected.elapsedKnown ? `${selected.timeAlive.toFixed(0)}s` : 'Elapsed unavailable'}</p></div><button type="button" onClick={() => setSelectedAgentId(null)} className="rounded px-2 py-1" style={{ border: `1px solid ${COLORS.toggleBorder}` }}>Close details</button></div>
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-[10px]">
        <dt style={{ color: COLORS.textMuted }}>Assignment</dt><dd className="break-words">{selected.task ?? 'Unavailable'}</dd>
        <dt style={{ color: COLORS.textMuted }}>Latest observed activity</dt><dd className="break-words">{selected.currentTool ?? 'Unavailable'}</dd>
        <dt style={{ color: COLORS.textMuted }}>Context</dt><dd>{selected.contextKnown ? `${selected.tokensUsed.toLocaleString()} / ${selected.tokensMax.toLocaleString()}` : 'Unavailable'}</dd>
        <dt style={{ color: COLORS.textMuted }}>Parent</dt><dd>{parent?.name ?? (selected.recordedParentId ? `${recordedParent?.agentName ?? selected.recordedParentId} recorded \u00b7 not displayed` : 'None recorded')}</dd>
        <dt style={{ color: COLORS.textMuted }}>Children</dt><dd>{recordedChildCount ? `${recordedChildCount} recorded \u00b7 ${children.length} shown${children.length ? `: ${children.map(child => child.name).join(', ')}` : ''}` : 'None recorded'}</dd>
        <dt style={{ color: COLORS.textMuted }}>Chat</dt><dd>Unavailable from privacy-safe lifecycle data</dd>
        <dt style={{ color: COLORS.textMuted }}>Files</dt><dd>Unavailable when not authoritatively reported</dd>
      </dl>
      <h5 className="mt-4 text-[10px] uppercase tracking-wider" style={{ color: COLORS.textMuted }}>Recent commands and tools</h5>
      {selectedActivity.length ? <ol className="mt-2 space-y-2">{selectedActivity.map(event => <li key={event.id} className="break-words rounded p-2" style={{ background: COLORS.holoBg05 }}>{event.label}</li>)}</ol> : <p className="mt-2 text-[10px]" style={{ color: COLORS.textMuted }}>No authoritative activity available.</p>}
      {selectedSession ? <button type="button" onClick={() => onOpen(selectedSession.id)} className="mt-4 w-full rounded px-3 py-2" style={{ background: COLORS.toggleActive, border: `1px solid ${COLORS.toggleBorder}` }}>Focus agent session</button> : null}
    </aside> : null}
    {model.totalAgents > CONTROL_ROOM_GRAPH_LIMIT ? <p className="absolute bottom-3 left-3 rounded px-2 py-1 text-[10px]" style={{ color: COLORS.textMuted, background: COLORS.panelBg }}>Showing {CONTROL_ROOM_GRAPH_LIMIT} of {model.totalAgents} registered agents</p> : null}
  </section>
}
