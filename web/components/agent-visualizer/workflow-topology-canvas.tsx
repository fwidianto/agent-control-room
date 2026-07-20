'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OrchestrationState } from '@/lib/orchestration-state'
import { orchestrationEntityKey } from '@/lib/orchestration-state'
import { buildWorkflowCanvasModel, CONTROL_ROOM_GRAPH_LIMIT, safeAgentDisplayName, type SessionActivityEvent } from '@/lib/workflow-control-room'
import type { SessionSummary } from '@/lib/session-summary'
import { createEmptyState } from '@/hooks/simulation/types'
import { replayRuntimeActivity, runtimeActivityReplayEnd, RUNTIME_ACTIVITY_VISIBLE_MS, type RuntimeActivityEvent } from '@/lib/runtime-activity'
import { AgentCanvas } from './canvas'
import { COLORS } from '@/lib/colors'
import { installFullscreenMode } from '@/lib/fullscreen-mode'

type CameraCommand = { id: number; type: 'fit' | 'recenter' | 'zoom-in' | 'zoom-out' | 'reset' }

export function WorkflowTopologyCanvas({ workflowId, state, sessions, activity, runtimeActivity, now, onOpen, secondaryPanelIds }: {
  workflowId: string
  state: OrchestrationState
  sessions: SessionSummary[]
  activity: SessionActivityEvent[]
  runtimeActivity: RuntimeActivityEvent[]
  now: number
  onOpen: (id: string) => void
  secondaryPanelIds: { assignments: string; timeline: string; sessions: string }
}) {
  const [showcaseMode, setShowcaseMode] = useState(false)
  const [replayMode, setReplayMode] = useState(false)
  const [replayPlaying, setReplayPlaying] = useState(false)
  const [replaySpeed, setReplaySpeed] = useState(1)
  const [replayCursor, setReplayCursor] = useState<number | null>(null)
  const [selectedToolCallId, setSelectedToolCallId] = useState<string | null>(null)
  const [selectedDiscoveryId, setSelectedDiscoveryId] = useState<string | null>(null)
  const workflowSessionIds = useMemo(() => new Set([...state.agents.values()]
    .filter(agent => agent.workflowId === workflowId && agent.sessionId)
    .map(agent => agent.sessionId!)), [state, workflowId])
  const currentWorkflowActivity = useMemo(() => runtimeActivity.filter(event => workflowSessionIds.has(event.sessionId) && (!event.workflowId || event.workflowId === workflowId)), [runtimeActivity, workflowId, workflowSessionIds])
  const orderedRuntimeActivity = useMemo(() => [...currentWorkflowActivity].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id)), [currentWorkflowActivity])
  const replayStart = orderedRuntimeActivity[0]?.timestamp ?? now
  const replayEnd = runtimeActivityReplayEnd(orderedRuntimeActivity, now)
  const displayNow = replayMode ? (replayCursor ?? replayStart) : now
  const displayRuntimeActivity = useMemo(() => replayMode
    ? replayRuntimeActivity(orderedRuntimeActivity, displayNow)
    : orderedRuntimeActivity.filter(event => event.status === 'running' || !event.completedAt || displayNow - event.completedAt <= RUNTIME_ACTIVITY_VISIBLE_MS), [displayNow, orderedRuntimeActivity, replayMode])

  useEffect(() => {
    if (!replayMode) return
    setReplayCursor(current => current ?? replayStart)
  }, [replayMode, replayStart])

  useEffect(() => {
    if (!replayMode || !replayPlaying) return
    const timer = window.setInterval(() => {
      setReplayCursor(current => {
        const next = (current ?? replayStart) + 100 * replaySpeed
        return next >= replayEnd ? replayEnd : next
      })
    }, 100)
    return () => window.clearInterval(timer)
  }, [replayEnd, replayMode, replayPlaying, replaySpeed, replayStart])

  useEffect(() => {
    if (replayMode && replayPlaying && replayCursor !== null && replayCursor >= replayEnd) setReplayPlaying(false)
  }, [replayCursor, replayEnd, replayMode, replayPlaying])

  const baseModel = useMemo(() => buildWorkflowCanvasModel(workflowId, state, sessions, activity, displayRuntimeActivity), [activity, displayRuntimeActivity, sessions, state, workflowId])
  const model = useMemo(() => ({
    ...baseModel,
    agents: new Map([...baseModel.agents].map(([id, agent]) => [id, {
      ...agent,
      timeAlive: agent.elapsedKnown && agent.spawnTime ? Math.max(0, (agent.completeTime ?? displayNow / 1000) - agent.spawnTime) : 0,
    }])),
    signals: baseModel.signals.filter(signal => displayNow >= signal.timestamp && displayNow - signal.timestamp <= 10_000),
  }), [baseModel, displayNow])
  const simulation = useMemo(() => createEmptyState({ agents: model.agents, toolCalls: model.toolCalls, discoveries: model.discoveries, edges: model.edges, isPlaying: false, currentTime: displayNow / 1000 }), [displayNow, model])
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
  const selectAgent = useCallback((agentId: string | null) => { setSelectedAgentId(agentId); setSelectedToolCallId(null); setSelectedDiscoveryId(null) }, [])
  const selectToolCall = useCallback((id: string | null) => { setSelectedToolCallId(id); setSelectedDiscoveryId(null); setSelectedAgentId(null) }, [])
  const selectDiscovery = useCallback((id: string | null) => { setSelectedDiscoveryId(id); setSelectedToolCallId(null); setSelectedAgentId(null) }, [])
  const selected = selectedAgentId ? model.agents.get(selectedAgentId) : undefined
  const selectedToolCall = selectedToolCallId ? model.toolCalls.get(selectedToolCallId) : undefined
  const selectedDiscovery = selectedDiscoveryId ? model.discoveries.find(discovery => discovery.id === selectedDiscoveryId) : undefined
  const selectedSessionId = selectedAgentId ? sessionByAgent.get(selectedAgentId) : undefined
  const selectedSession = selectedSessionId ? sessions.find(session => session.id === selectedSessionId) : undefined
  const selectedActivity = selectedSessionId ? activity.filter(event => event.sessionId === selectedSessionId).slice(-8).reverse() : []
  const selectedRuntimeActivity = selectedSessionId ? displayRuntimeActivity.filter(event => event.sessionId === selectedSessionId).slice(-8).reverse() : []
  const parent = selected?.parentId ? model.agents.get(selected.parentId) : undefined
  const recordedParent = selected?.recordedParentId ? state.agents.get(orchestrationEntityKey(workflowId, selected.recordedParentId)) : undefined
  const children = selected ? [...model.agents.values()].filter(agent => agent.parentId === selected.id) : []
  const recordedChildCount = selected ? [...state.delegations.values()].filter(delegation => delegation.workflowId === workflowId && delegation.parentAgentId === selected.id).length : 0

  const runCameraCommand = useCallback((type: CameraCommand['type']) => setCameraCommand({ id: ++commandIdRef.current, type }), [])
  const enterFullscreen = useCallback(() => {
    scrollRef.current = window.scrollY
    setFullscreen(true)
  }, [])
  const enterShowcase = useCallback(() => {
    scrollRef.current = window.scrollY
    setShowcaseMode(true)
    setReplayMode(false)
    setReplayPlaying(false)
    setFullscreen(true)
  }, [])
  const exitFullscreen = useCallback((panelId?: string) => {
    targetPanelRef.current = panelId
    setShowcaseMode(false)
    setReplayMode(false)
    setReplayPlaying(false)
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
        <span className="px-2" style={{ color: COLORS.holoBright }}>{showcaseMode ? (replayMode ? 'Replay · privacy mode' : 'Live · privacy mode') : fullscreen ? 'Fullscreen interaction mode' : 'Live interaction canvas'}</span>
        {showcaseMode ? <span className="px-2" style={{ color: COLORS.textMuted }}>Legend: agents = authority · links = relationships · cards = observed activity</span> : null}
        <button type="button" onClick={() => runCameraCommand('fit')} className="rounded px-2 py-1" title="Fit all agents">Fit all</button>
        <button type="button" onClick={() => runCameraCommand('recenter')} className="rounded px-2 py-1" title="Recenter graph">Recenter</button>
        <button type="button" onClick={() => runCameraCommand('zoom-in')} className="rounded px-2 py-1" aria-label="Zoom in">+</button>
        <button type="button" onClick={() => runCameraCommand('zoom-out')} className="rounded px-2 py-1" aria-label="Zoom out">{`\u2212`}</button>
        <button type="button" onClick={() => runCameraCommand('reset')} className="rounded px-2 py-1">Reset zoom</button>
      </div>
      {fullscreen ? (
        <div className="flex flex-wrap items-start justify-end gap-2">
          <button type="button" onClick={() => { setShowcaseMode(true); setReplayMode(false); setReplayPlaying(false) }} className="rounded-lg px-3 py-2 text-[10px]" style={{ background: COLORS.toggleActive, border: `1px solid ${COLORS.toggleBorder}` }}>Showcase</button>
          {showcaseMode ? <>
            <button type="button" onClick={() => { const next = !replayMode; setReplayMode(next); setReplayPlaying(next); setReplayCursor(next ? replayStart : null) }} className="rounded-lg px-3 py-2 text-[10px]" style={{ background: COLORS.toggleActive, border: `1px solid ${COLORS.toggleBorder}` }}>{replayMode ? 'Live' : 'Replay'}</button>
            {replayMode ? <>
              <button type="button" onClick={() => setReplayPlaying(value => !value)} className="rounded-lg px-3 py-2 text-[10px]" style={{ background: COLORS.toggleActive, border: `1px solid ${COLORS.toggleBorder}` }}>{replayPlaying ? 'Pause' : 'Resume'}</button>
              <button type="button" onClick={() => { setReplayCursor(replayStart); setReplayPlaying(true) }} className="rounded-lg px-3 py-2 text-[10px]" style={{ background: COLORS.toggleActive, border: `1px solid ${COLORS.toggleBorder}` }}>Restart replay</button>
              <label className="rounded-lg px-2 py-2 text-[10px]" style={{ background: COLORS.toggleActive, border: `1px solid ${COLORS.toggleBorder}` }}>Speed <select aria-label="Replay speed" value={replaySpeed} onChange={event => setReplaySpeed(Number(event.target.value))}><option value="0.5">0.5x</option><option value="1">1x</option><option value="2">2x</option><option value="4">4x</option></select></label>
            </> : null}
          </> : null}
          <details className="rounded-lg p-1 text-[10px]" style={{ background: `${COLORS.panelBg}e8`, border: `1px solid ${COLORS.holoBorder10}` }}><summary className="cursor-pointer px-2 py-1">Secondary panels</summary><div className="mt-1 grid gap-1"><button type="button" onClick={() => exitFullscreen(secondaryPanelIds.assignments)} className="rounded px-2 py-1 text-left">Assignments</button><button type="button" onClick={() => exitFullscreen(secondaryPanelIds.timeline)} className="rounded px-2 py-1 text-left">Combined timeline</button><button type="button" onClick={() => exitFullscreen(secondaryPanelIds.sessions)} className="rounded px-2 py-1 text-left">Session cards</button></div></details>
          <button ref={exitButtonRef} type="button" onClick={() => exitFullscreen()} className="rounded-lg px-3 py-2 text-[10px]" style={{ background: COLORS.toggleActive, border: `1px solid ${COLORS.toggleBorder}` }}>Exit fullscreen</button>
        </div>
      ) : <div className="flex gap-2"><button ref={enterButtonRef} type="button" onClick={enterFullscreen} className="rounded-lg px-3 py-2 text-[10px]" style={{ background: COLORS.toggleActive, border: `1px solid ${COLORS.toggleBorder}` }}>Fullscreen canvas</button><button type="button" onClick={enterShowcase} className="rounded-lg px-3 py-2 text-[10px]" style={{ background: COLORS.toggleActive, border: `1px solid ${COLORS.toggleBorder}` }}>Showcase</button></div>}
    </div>
    <AgentCanvas simulationRef={simulationRef} selectedAgentId={selectedAgentId} hoveredAgentId={hoveredAgentId} showStats={false} showHexGrid edgeSignals={model.signals} showOperationalLabels zoomToFitTrigger={model.agents.size + model.toolCalls.size + model.discoveries.length} cameraCommand={cameraCommand} autoFitOnResize pauseAutoFit={Boolean(selected || selectedToolCall || selectedDiscovery)} onAgentClick={selectAgent} onAgentHover={setHoveredAgentId} onAgentDrag={() => {}} onContextMenu={() => {}} onToolCallClick={selectToolCall} selectedToolCallId={selectedToolCallId} onDiscoveryClick={selectDiscovery} selectedDiscoveryId={selectedDiscoveryId} />
    <ul className="sr-only">{[...model.agents.values()].map(agent => <li key={agent.id}><button type="button" onClick={() => selectAgent(agent.id)}>{agent.name}: {agent.statusLabel ?? agent.state}. Open agent details beside graph.</button></li>)}{[...model.toolCalls.values()].map(tool => <li key={tool.id}><button type="button" onClick={() => selectToolCall(tool.id)}>{tool.args}. Open artifact details.</button></li>)}{model.discoveries.map(discovery => <li key={discovery.id}><button type="button" onClick={() => selectDiscovery(discovery.id)}>{discovery.label}. Open artifact details.</button></li>)}</ul>
    {selected ? <aside aria-label={`${selected.name} details`} className={`absolute inset-x-3 bottom-3 max-h-[42%] overflow-auto rounded-xl p-4 text-xs shadow-2xl sm:inset-x-auto sm:bottom-3 sm:right-3 sm:max-h-none sm:w-80 ${fullscreen ? 'sm:top-16' : 'sm:top-3'}`} style={{ color: COLORS.holoBright, background: `${COLORS.panelBg}f2`, border: `1px solid ${COLORS.holoBorder10}` }}>
      <div className="flex items-start justify-between gap-3"><div><h4 className="text-sm">{selected.name}</h4><p className="mt-1 text-[10px]" style={{ color: COLORS.textMuted }}>{selected.statusLabel ?? 'Unknown'} {`\u00b7`} {selected.elapsedKnown ? `${selected.timeAlive.toFixed(0)}s` : 'Elapsed unavailable'}</p></div><button type="button" onClick={() => selectAgent(null)} className="rounded px-2 py-1" style={{ border: `1px solid ${COLORS.toggleBorder}` }}>Close details</button></div>
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-[10px]">
        <dt style={{ color: COLORS.textMuted }}>Assignment</dt><dd className="break-words">{selected.task ?? 'Unavailable'}</dd>
        <dt style={{ color: COLORS.textMuted }}>Latest observed activity</dt><dd className="break-words">{selected.currentTool ?? 'Unavailable'}</dd>
        <dt style={{ color: COLORS.textMuted }}>Context</dt><dd>{selected.contextKnown ? `${selected.tokensUsed.toLocaleString()} / ${selected.tokensMax.toLocaleString()}` : 'Unavailable'}</dd>
        <dt style={{ color: COLORS.textMuted }}>Parent</dt><dd>{parent?.name ?? (selected.recordedParentId ? `${safeAgentDisplayName(recordedParent?.agentName, selected.recordedParentId)} recorded \u00b7 not displayed` : 'None recorded')}</dd>
        <dt style={{ color: COLORS.textMuted }}>Children</dt><dd>{recordedChildCount ? `${recordedChildCount} recorded \u00b7 ${children.length} shown${children.length ? `: ${children.map(child => child.name).join(', ')}` : ''}` : 'None recorded'}</dd>
        <dt style={{ color: COLORS.textMuted }}>Chat</dt><dd>Unavailable from privacy-safe lifecycle data</dd>
        <dt style={{ color: COLORS.textMuted }}>Files</dt><dd>Unavailable when not authoritatively reported</dd>
      </dl>
      <h5 className="mt-4 text-[10px] uppercase tracking-wider" style={{ color: COLORS.textMuted }}>Recent commands and tools</h5>
      {selectedRuntimeActivity.length ? <ol className="mt-2 space-y-2">{selectedRuntimeActivity.map(event => <li key={event.id} className="break-words rounded p-2" style={{ background: COLORS.holoBg05 }}>{event.label} · {event.status === 'unknown' ? 'Outcome unavailable' : event.status}{event.durationMs !== undefined ? ` · ${(event.durationMs / 1000).toFixed(1)}s` : ''}</li>)}</ol> : selectedActivity.length ? <ol className="mt-2 space-y-2">{selectedActivity.map(event => <li key={event.id} className="break-words rounded p-2" style={{ background: COLORS.holoBg05 }}>{event.label}</li>)}</ol> : <p className="mt-2 text-[10px]" style={{ color: COLORS.textMuted }}>No authoritative activity available.</p>}
      {selectedSession ? <button type="button" onClick={() => onOpen(selectedSession.id)} className="mt-4 w-full rounded px-3 py-2" style={{ background: COLORS.toggleActive, border: `1px solid ${COLORS.toggleBorder}` }}>Focus agent session</button> : null}
    </aside> : null}
    {selectedToolCall ? <aside aria-label="Artifact details" className={`absolute inset-x-3 bottom-3 max-h-[42%] overflow-auto rounded-xl p-4 text-xs shadow-2xl sm:inset-x-auto sm:bottom-3 sm:right-3 sm:max-h-none sm:w-80 ${fullscreen ? 'sm:top-16' : 'sm:top-3'}`} style={{ color: COLORS.holoBright, background: `${COLORS.panelBg}f2`, border: `1px solid ${COLORS.holoBorder10}` }}><div className="flex items-start justify-between gap-3"><h4 className="text-sm">{selectedToolCall.args}</h4><button type="button" onClick={() => selectToolCall(null)} className="rounded px-2 py-1" style={{ border: `1px solid ${COLORS.toggleBorder}` }}>Close details</button></div><dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-[10px]"><dt style={{ color: COLORS.textMuted }}>Lifecycle</dt><dd>{selectedToolCall.state === 'running' ? 'Running' : selectedToolCall.state === 'error' ? 'Failed' : 'Completed · outcome unavailable'}</dd><dt style={{ color: COLORS.textMuted }}>Output</dt><dd>Unavailable from privacy-safe activity</dd></dl></aside> : null}
    {selectedDiscovery ? <aside aria-label="Artifact details" className={`absolute inset-x-3 bottom-3 max-h-[42%] overflow-auto rounded-xl p-4 text-xs shadow-2xl sm:inset-x-auto sm:bottom-3 sm:right-3 sm:max-h-none sm:w-80 ${fullscreen ? 'sm:top-16' : 'sm:top-3'}`} style={{ color: COLORS.holoBright, background: `${COLORS.panelBg}f2`, border: `1px solid ${COLORS.holoBorder10}` }}><div className="flex items-start justify-between gap-3"><h4 className="text-sm">{selectedDiscovery.label}</h4><button type="button" onClick={() => selectDiscovery(null)} className="rounded px-2 py-1" style={{ border: `1px solid ${COLORS.toggleBorder}` }}>Close details</button></div><p className="mt-3 text-[10px]" style={{ color: COLORS.textMuted }}>{selectedDiscovery.content}</p><p className="mt-2 text-[10px]" style={{ color: COLORS.textMuted }}>Contents unavailable from privacy-safe activity.</p></aside> : null}
    {model.totalAgents > CONTROL_ROOM_GRAPH_LIMIT ? <p className="absolute bottom-3 left-3 rounded px-2 py-1 text-[10px]" style={{ color: COLORS.textMuted, background: COLORS.panelBg }}>Showing {CONTROL_ROOM_GRAPH_LIMIT} of {model.totalAgents} registered agents</p> : null}
  </section>
}
