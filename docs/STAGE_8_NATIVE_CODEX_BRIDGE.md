# Stage 8 native Codex bridge

## Discovery record

Discovery ran against Codex CLI `0.144.6` on 2026-07-19 with two real native read-only subagents.

| Classification | Finding |
|---|---|
| Confirmed | Root thread `019f7a48-16d8-7722-9fd6-ea6ebf1c084d` spawned Luna/Gauss thread `019f7a49-2bf6-73b2-bc5f-216d5710a371` at `/root/luna_discovery` and Terra/Volta thread `019f7a49-5d73-7731-a8d5-517b82f51391` at `/root/terra_review`. |
| Confirmed | Each child rollout's first `session_meta` explicitly contains its thread ID, root `session_id`, `parent_thread_id`, `forked_from_id`, `thread_source: "subagent"`, native nickname, agent path, and `source.subagent.thread_spawn` metadata. |
| Confirmed | The root rollout records `spawn_agent` with a stable call ID and safe `task_name`; a matching `sub_agent_activity` `started` record carries the child thread ID and agent path. The assignment message is private and is never read into an Agent Flow event. |
| Confirmed | `task_started`, `task_complete`, and interrupted `turn_aborted` records exist. A later child turn can start after a completed turn. `wait_agent` call/output explicitly brackets coordinator waiting and resumption. |
| Confirmed | A recorded `list_agents` result exposes only two sampled status shapes: `running` and an object keyed `completed`. Its message fields are private. |
| Confirmed | `C:\Users\fauzan\.codex\state_5.sqlite` corroborates relationships in `thread_spawn_edges(parent_thread_id, child_thread_id, status)` and names/paths in `threads`, but its `open`/`closed` edge status is not agent lifecycle. Completed children can retain an `open` edge. |
| Confirmed | JSONL append order is authoritative within one rollout file. Records carry timestamps, but no authoritative total order exists across files. |
| Inferred | A spawn call ID is a deterministic normalized assignment ID. This inference is used only for event identity; it never creates membership or a relationship. |
| Inferred | `task_complete` means a turn returned control. It does not prove assignment success or terminal agent completion. |
| Unknown | A safe persisted name for the root agent. `Sol` exists only in private prompt content; the bridge uses a neutral ID-derived label. |
| Unknown | Child waiting, assignment success/failure, workflow completion/failure, a persistent `/agent` live-state feed, and a cross-file total order. No native failure record was observed. |

Relevant rollout files:

- Root: `C:\Users\fauzan\.codex\sessions\2026\07\19\rollout-2026-07-19T19-09-32-019f7a48-16d8-7722-9fd6-ea6ebf1c084d.jsonl`
- Luna: `C:\Users\fauzan\.codex\sessions\2026\07\19\rollout-2026-07-19T19-10-43-019f7a49-2bf6-73b2-bc5f-216d5710a371.jsonl`
- Terra: `C:\Users\fauzan\.codex\sessions\2026\07\19\rollout-2026-07-19T19-10-56-019f7a49-5d73-7731-a8d5-517b82f51391.jsonl`

## Source of authority

The runtime source is the local Codex rollout JSONL already tailed by `CodexSessionWatcher`. Relationships come only from explicit child `session_meta.parent_thread_id`/`source.subagent.thread_spawn` fields. Root workflow membership comes from the explicit child `session_id`. Spawn call IDs join to child `sub_agent_activity.event_id`; timestamps, workspace similarity, file proximity, names, and event order never establish parenthood.

`state_5.sqlite` is discovery corroboration, not a runtime dependency. Agent Flow supports Node 20 and has no SQLite dependency, while the rollout contains the same authoritative relationship. Codex hooks are also not required: the bridge stays passive and needs no Codex patch, plugin, launcher, or cloud service.

## Protocol v1 mapping

All generated records use source `native-codex-rollout` and deterministic `codex-native:` event IDs.

| Native record | Protocol v1 event | Semantics |
|---|---|---|
| First explicit child metadata for a root | `workflow_started` | Starts one native workflow keyed by the root thread ID. |
| Root or explicit descendant thread | `workflow_session_registered` | Registers the real Codex thread ID. |
| Root or explicit descendant thread | `agent_registered` | Uses the native path/nickname when present and a neutral short-ID label otherwise. |
| Explicit child metadata | `delegation_created` | Uses only its explicit child and parent thread IDs. |
| Matched `spawn_agent` call and `sub_agent_activity: started` | `assignment_created` | Uses the call ID and safe `task_name`; private assignment text is discarded. No assignment lifecycle state is emitted because protocol v1 cannot represent a returned-but-not-completed assignment without claiming it is active, waiting, or complete. |
| First own `task_started` | `agent_status_updated(active)` | Marks execution only after the child activation marker, excluding forked parent history copied into child rollouts. |
| Later own `task_started` after a return | `agent_resumed` | Marks an authoritative new child turn. |
| Own `task_complete` | `agent_returned` | Means returned control, not success or terminal completion. |
| Root `wait_agent` call | `agent_waiting` | The coordinator is synchronously waiting. It says nothing about child waiting. |
| Matching `wait_agent` output | `agent_resumed` | The coordinator resumed even when the wait timed out. |
| Recorded `list_agents` completed discriminator | `agent_status_updated(completed)` | Emitted only for the explicitly named native agent path; message content is ignored. |

No event is emitted for child waiting, `assignment_started`, assignment completion/failure, interrupted-as-failed, edge closure, inactivity, process disappearance, workflow completion, or unknown agent paths. `turn_aborted(reason: interrupted)` remains unsupported because protocol v1 has no interrupted state and failure would be false.

## Watcher, replay, and restart

The existing Codex watcher owns discovery, workspace filtering, file watching, polling fallback, partial-line handling, and replay. The native normalizer consumes the same completed JSONL lines and keeps only bounded safe metadata needed for protocol events. Child lifecycle is ignored until that child's own `sub_agent_activity: started` marker, preventing inherited fork history from being attributed to the child.

Every normalized event ID is derived from immutable native IDs such as root thread ID, child thread ID, spawn call ID, and turn ID. Polling, reconnect, replay, and restart therefore reproduce the same IDs. The existing orchestration reducer and snapshot transport deduplicate them. Presentation order is timestamp, ingestion order, and event ID; no relationship or status is inferred from that order. Malformed, oversized, incomplete, unsupported, or privacy-unsafe records are skipped.

Manual `.agent-flow/orchestration.jsonl` protocol v1 remains enabled and Claude/legacy ungrouped sessions are unchanged. If native and manual membership conflict for the same runtime session, the session is left ungrouped/invalid rather than choosing a source.

## Privacy and limits

The bridge may retain only IDs, timestamps, Codex runtime, workspace match, agent path/nickname, safe task name, lifecycle discriminator, and status discriminator. It must never emit or retain prompts, assignment messages, transcript bodies, final messages, tool input/output, reasoning, titles, previews, first-user messages, environment data, tokens, credentials, cookies, or log bodies.

History remains bounded by the existing recent-session scan and protocol event caps. A missing or disabled Codex runtime is a silent no-op. Unsupported states remain Unknown; inactivity remains Inactive at the session layer and never becomes completion.

## Deferred roadmap

These milestones are explicitly deferred and are not blockers for the Stage 8 checkpoint:

- **Packaged application experience:** ship a desktop application with simpler startup, application-window management, reliable background services, visible connection status, installation, and updates.
- **UX and language audit:** review redundant copy, conflicting or duplicated statuses, unclear labels, excessive technical IDs, terminology consistency, repeated metrics, truncation, spacing, visual hierarchy, and normal/fullscreen navigation.
- **Live agent-to-artifact interaction:** extend the canvas with authoritative agent-to-command, file, patch, tool, result, and review-finding activity. Never infer file ownership, messages, edits, or handoffs when Codex does not expose them.
