# MVP Agent Control Room

## Problem and goal

Agent Flow detects multiple local Codex and Claude sessions but presents them as independent tabs. The MVP adds one workspace-level overview that shows every detected session, its current truthful state and activity, context use, and a direct route to the existing detailed visualizer.

## Current state

- Watchers discover workspace-matching sessions and emit lifecycle messages plus session-scoped events.
- The web bridge buffers all events by session, while the simulation renders only the selected session.
- `SessionInfo` currently carries identity, label, lifecycle status, start time, and last activity time. Runtime and workspace provenance must be added at the watcher boundary; model and context can be derived from session events.
- A session is ended after `INACTIVITY_TIMEOUT_MS` (five minutes) and reactivated when new content arrives. Discovery scans every second and initially admits files modified within ten minutes.

## Scope

- Add a flat aggregate view listing all detected sessions.
- Show label, shortened ID, runtime, model, status, elapsed time, latest interpreted activity, context tokens/percentage, and workspace when available.
- Maintain an O(1) summary per session as lifecycle messages and ordered events arrive.
- Open the unchanged detailed visualization by selecting a session.
- Add deterministic local status/activity helpers and focused tests.

## Non-goals

- No inferred parent-child or shared-workflow relationships.
- No invented agent roles, LLM summarization, orchestration protocol, relay rewrite, detailed-view redesign, analytics, authentication, storage, or deployment work.

## Status semantics

- **Active:** lifecycle says active and the latest meaningful event is not a wait signal.
- **Waiting:** lifecycle says active and the latest meaningful event is `permission_requested` or `agent_idle`.
- **Completed:** the existing watcher lifecycle emitted `session-ended` after five minutes without file activity.
- **Stale:** reserved for a future authoritative lifecycle signal; the MVP does not fabricate it from browser time.
- Any new event updates last activity; a lifecycle restart returns the session to Active or Waiting according to its latest event.

## Activity semantics

Activity is a pure mapping from the latest meaningful session event and tool name. Examples: Read -> "Inspecting source files" (repository instruction files -> "Reading repository instructions"); Glob/Grep/search commands -> "Searching the codebase"; Edit/Write -> "Editing a file"; test commands -> "Running tests"; WebSearch/WebFetch -> "Performing a web search"; permission/idle -> "Waiting for another result"; tool result -> "Reviewing command output". Unknown events fall back to a neutral local description or the last meaningful activity; raw JSON is never required.

## Acceptance criteria

1. Every detected session appears together and updates as lifecycle/events arrive.
2. Available identity, runtime, model, status, elapsed time, activity, context usage, and workspace data are shown without invented values.
3. Missing optional data renders gracefully.
4. Sessions remain flat and the detailed visualizer opens from each row/card.
5. Multiple-session, missing-data, status, activity, and navigation behavior are covered by deterministic tests.
6. Relevant tests, type checks, and production/web builds pass.

## Affected architecture

- Extend the shared/mirrored session protocol with optional authoritative runtime/workspace metadata.
- Add runtime provenance where Claude/Codex watchers create session snapshots and lifecycle starts.
- Extend the web bridge with per-session aggregate summaries derived incrementally from all buffered events.
- Add one control-room component and a minimal overview/detail toggle in the existing visualizer shell.

## Risks

- Replayed events use session-relative time, so summaries must preserve per-session arrival order rather than compare times across sessions.
- Lifecycle completion is inactivity-based and may classify long silent thinking as completed; the UI must describe the existing signal, not claim process termination.
- Initial lists have more accurate timestamps than restart messages; updates must preserve known start time.
- Optional context/model/workspace fields may be absent, and event buffers are unbounded; summaries must not add repeated history scans.

## Validation plan

- Run `pnpm.cmd test`, extension tests and TypeScript checks, web TypeScript checks, web production build, and the all/package build where applicable.
- Add focused deterministic tests for status and activity mapping, multiple sessions, absent optional data, and detail navigation state.
- Review responsive/accessibility behavior and confirm the final diff excludes generated output, logs, rollout/session data, secrets, and unrelated files.
