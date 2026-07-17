# Agent Control Room — Stages 4–7

## Problem and end state

The MVP shows local sessions truthfully but cannot identify coordinated workflows, assignments, or relationships. Stages 4–7 add an explicit local orchestration record and a workflow-level control room while preserving the aggregate session overview and detailed visualizer.

The product must distinguish authoritative orchestration data from session-derived activity and unavailable data. It must never group sessions or create relationships from workspace, time, labels, prompts, model, or event order.

## Current architecture

- Claude and Codex watchers discover workspace-matching transcript/rollout files and emit session lifecycle plus `AgentEvent` streams.
- The extension posts the same protocol to its webview; the standalone relay buffers up to 5,000 events per session and replays them over SSE.
- The browser buffers events by session, updates an O(1) summary per event, and swaps the existing detailed visualization by selected session.
- Watcher inactivity after five minutes emits `session-ended`; the UI correctly calls this `Inactive`, not completed work.

## Confirmed limitations

- Neither runtime exposes a shared cross-session workflow identity contract.
- Codex rollouts do not provide trustworthy parent-child subagent relationships.
- Environment variables in an independently launched agent process are not visible reliably to the visualizer process.
- Existing Claude subagent events describe runtime-local visualization and are not a cross-runtime workflow contract.
- Relay history is bounded; browser session history is currently unbounded.
- The existing protocol keys all session state by bare `sessionId`. A cross-runtime ID collision therefore fails workflow membership closed; Stage 4 does not attempt a protocol-wide composite-key migration.

## Authority and transport

The authoritative source is a producer-written, append-only JSONL file at `.agent-flow/orchestration.jsonl` in the watched workspace, overridable by `AGENT_FLOW_ORCHESTRATION_LOG`. The launcher or orchestrator owns writes; Agent Flow is a read-only consumer. The file is local runtime state and remains ignored by Git.

Every record has `eventId`, `eventVersion`, `type`, `timestamp`, `workflowId`, and `source`. Session membership and relationships exist only when an accepted record explicitly names their IDs. Agent Flow reports provenance as `Explicit orchestration event`; absence remains `Unavailable` or ungrouped.

Privacy rules:

- IDs, short display names, roles, assignment titles, status, dependency IDs, and concise reasons are allowed.
- Prompts, transcript bodies, tool output, secrets, tokens, credentials, and environment dumps are not accepted metadata fields.
- Unknown fields are ignored and never rendered.
- The file is local, not telemetered, and retained until its owner deletes it.

## Stage 4 — authoritative workflow identity

Add the version-1 `workflow_session_registered` record with:

- required `workflowId`, `workflowName`, `workflowCreatedAt`, `workflowSource`, `sessionId`, and `runtime`;
- optional `workflowDescription`;
- optional `expiresAt`, after which membership is ignored.

Malformed, unsupported, expired, duplicate, or conflicting records fail closed. The latest valid record for the same event ID is not reapplied; duplicate workflow names remain distinct by ID. The protocol carries optional typed workflow identity on sessions and replay reconstructs identity from the file. Group only explicit memberships; otherwise render `Ungrouped Sessions`.

Gate: multi-workflow, duplicate-name, malformed, replay, legacy, no-inference, and detailed-navigation tests pass; builds pass; Terra confirms truthfulness.

## Stage 5 — explicit orchestration events

Extend version 1 with:

- `workflow_started`, `workflow_updated`, `workflow_completed`;
- `agent_registered`;
- `assignment_created`, `assignment_started`, `assignment_updated`, `assignment_blocked`, `assignment_completed`, `assignment_failed`;
- `delegation_created`, `dependency_created`;
- `agent_waiting`, `agent_resumed`, `agent_returned`;
- `orchestration_message`.

Fields are type-dependent and may include `agentId`, `agentName`, `agentRole`, `sessionId`, `parentAgentId`, `parentSessionId`, `assignmentId`, `assignmentTitle`, `assignmentDescription`, `dependencyIds`, `status`, `reason`, and safe `metadata`. Relationships and names come only from accepted records. Duplicate event IDs are idempotent; file order is ingestion order, while presentation order is `(timestamp, ingestionIndex, eventId)`. Missing parents remain unresolved, cycles are rejected from hierarchy rendering, and reassignment changes ownership only through an explicit event.

Gate: parsing, version, malformed, duplicate, delayed/out-of-order, missing-parent, cycle, reassignment, blocked/resumed, returned/completed/failed, replay, mixed-legacy, privacy, and no-inference tests pass; Terra approves provenance.

## Stage 6 — live workflow control room

Show workflow identity, authoritative status, elapsed time, session/agent counts, meaningful context totals, assignment progress and state counts. Render hierarchy only from valid explicit delegation; otherwise use a flat list. Combine accepted orchestration records with owned session lifecycle/tool events in a deterministic timeline, filterable by agent, session, assignment, and event type, with drill-down to the existing detailed view.

Statuses:

- `Active`: explicit assignment/workflow activity or an active session, without a stronger explicit state.
- `Waiting`: explicit wait event or existing session wait signal.
- `Blocked`: explicit blocked event with optional safe reason.
- `Inactive`: session watcher inactivity only.
- `Completed`: explicit assignment/workflow completion only.
- `Failed`: explicit failure only.
- `Unknown`: insufficient or contradictory authoritative data.

Incremental state is updated once per accepted event. Timeline retention is capped consistently with relay replay; the UI does not mount detailed visualizers per card. Keyboard focus, semantic lists/trees, text status labels, narrow layouts, long labels, and reduced motion are required; critical explanations cannot be hover-only.

Gate: authoritative hierarchy and flat fallback, timeline ordering/delay/filtering, status separation, navigation, incremental/large-volume behavior, accessibility source checks, tests and builds pass; Terra approves; rendered QA is recorded or remains an explicit manual gate.

## Stage 7 — product hardening

- Add protocol/replay/integration/malformed/performance/legacy regression tests.
- Make root development commands Windows-compatible while retaining macOS/Linux commands; document PowerShell startup.
- Document architecture, protocol, lifecycle, privacy, retention, troubleshooting, manual QA, contribution rules, and limitations.
- Keep local orchestration data, logs, builds, transcripts, and credentials ignored.
- Keep fork-specific orchestration isolated behind optional protocol fields and the sidecar reader.
- Improve only actionable startup/error text needed by this feature; no deployment expansion.

Gate: all relevant checks pass, Windows startup smoke succeeds, privacy and cleanup are explicit, legacy sessions work, Terra's full-diff High/Medium findings are resolved, branch is clean and pushed, and the result remains unmerged.

## Compatibility and migration

All new fields and messages are optional. Existing sessions and old relays continue as ungrouped sessions. An absent orchestration file is a silent no-op. Unsupported versions and malformed lines are skipped with bounded local warnings. Deleting or replacing the file and reconnecting rebuilds workflow state without changing transcript data.

## Performance and rollback

Parse each appended line once, deduplicate by bounded event-ID retention, and maintain maps keyed by workflow/session/agent/assignment. Bound replay and timeline history; do not rescan full histories during render. Rollback is removal of the optional reader/messages/UI grouping: watcher session data and the detailed visualizer remain unchanged.

## Validation plan

At every stage run focused tests plus relevant TypeScript and production builds. At Stage 7 attempt:

`pnpm.cmd test`, `pnpm.cmd --filter agent-flow test`, `pnpm.cmd --filter agent-flow lint`, `pnpm.cmd --filter agent-flow lint:test`, `pnpm.cmd --filter agent-flow-web exec tsc --noEmit`, `pnpm.cmd run build:web`, `pnpm.cmd run build:extension`, and `git diff --check`.

Rendered QA must cover multiple/ungrouped workflows, hierarchy and flat fallback, statuses, delayed updates, filters, details navigation, wide/narrow layouts, keyboard access, missing data, and absence of fabricated roles or relationships.

## Program stage gates

For each stage: Luna implements the frozen bounded scope; validation runs; Terra reviews only after implementation; Sol resolves accepted findings and reruns affected checks; a focused stage commit records the passed gate. Stop when authority, architecture, validation, privacy, or a required design decision cannot be satisfied truthfully.
