# Stage 10 live agent artifacts

## 1. Purpose

Stage 10 makes the live multi-agent canvas explain observed runtime work without changing orchestration protocol v1. It exposes bounded, privacy-safe labels for activity that the runtime actually reported and keeps missing evidence visibly unavailable.

## 2. User experience

Agent nodes remain the primary topology. A viewer can see registered parent-child relationships, current agent state, assignment context, runtime identity, and recent observed activity. Transient file, command, test, tool, patch, and returned-result nodes are attached only through an authoritative session-to-agent mapping.

## 3. Authority versus observation

Orchestration authority comes only from producer-owned protocol-v1 records: workflow membership, agent registration, delegation, assignment, status, and return lifecycle. Runtime activity is observational and is held in a separate `RuntimeActivityEvent` model. Timing, proximity, display names, and shared workspace paths never create ownership or delegation.

## 4. Evidence matrix

| Claim | Evidence | What it proves | What it does not prove | Fallback |
|---|---|---|---|---|
| Tool started | Claude `PreToolUse`/transcript `tool_use`; Codex function/custom tool call | Invocation was observed | Physical side effect or success | `Using` / operation label |
| Tool completed | Claude `PostToolUse`/`tool_result`; matching Codex output or completion record | A result/completion record was observed | Success unless explicit failure evidence exists | `Completed · outcome unavailable` |
| File read | Claude `Read` tool invocation | A read tool was invoked for the safe path | Physical file access if the tool failed; ownership | `Reading · File unavailable` |
| File inspection | Claude `Glob`/`Grep`, or a classified inspection command | Requested inspection operation was observed | A particular file was actually opened | `Inspecting` |
| Edit/write | Claude `Edit`/`Write`; Codex patch invocation | Mutation intent/invocation was observed | Mutation success or resulting contents | `Editing` / `Applying patch` |
| Shell command | Claude `Bash`; Codex command/custom tool evidence | Command invocation and, when present, completion were observed | Generic command success without explicit status | `Running · outcome unavailable` |
| Test | A command/tool label matches supported test command patterns | A test-like command was requested | Test pass/fail or complete test suite | `Testing · outcome unavailable` |
| Exit status | Explicit numeric exit status in runtime evidence | That exit status was reported | Correctness of the result | `Exit status unavailable` |
| Return | Explicit `agent_returned` or Claude subagent return | Control/result return was observed | Assignment success, acceptance, or finding validity | `Returning control · outcome unavailable` |
| Review/finding | No dedicated runtime evidence in current sources | Nothing authoritative in Stage 10 | Reviewer identity, diff inspection, finding production | `Review unavailable` |

Every relationship records its source, required fields, evidence class, safe label, stable identity, lifecycle, and retention policy in code and in this document. Raw output is never used as a display label.

## 5. Supported operations

`read`, `inspect`, `edit`, `apply_patch`, `execute`, `test`, `tool`, and authoritative `return` are supported when the corresponding runtime evidence exists. Start and completion are kept separate until the same safe call ID joins them.

## 6. Unsupported operations

Stage 10 does not claim physical file ownership, generic shell success, test pass/fail without explicit status, diff inspection, review activity, finding production, assignment success, workflow completion, or result acceptance. Inactivity is not completion. Cross-file causal ordering is unavailable.

## 7. Data model

`RuntimeActivityEvent` contains a stable event ID, runtime, optional workflow and agent references, an opaque session ID for association, timestamp, call ID, operation, artifact type, stable artifact ID, bounded display label, lifecycle phase, completion status, evidence source, authority, confidence, optional duration, and optional explicit exit status. The UI hides session and call IDs. The model intentionally has no prompt, transcript, file-content, command-output, or secret field.

## 8. Privacy and redaction

Display labels use workspace-relative paths. Outside-workspace paths become `External file`; protected names such as environment and credential files become `Protected file`. Commands are bounded and redact URLs, bearer values, sensitive HTTP headers, token/key/password assignments, common token prefixes, and absolute paths. File contents, prompts, reasoning, transcripts, command output, environment variables, cookies, credentials, and raw session IDs are not placed in the activity model.

## 9. Artifact identity

File nodes reuse `sessionId + safe relative path` identity. Command, test, tool, and patch calls use the runtime call ID; separate calls therefore remain separate. Returns use the authoritative session-to-agent/workflow association. Fallback IDs are deterministic hashes of bounded non-private event fields and are used only when a runtime did not provide a call ID.

## 10. Event ordering and deduplication

Events sort by timestamp, lifecycle phase, and stable ID. Replay and reconnect send the same events again safely: the activity reducer merges start/end pairs by stable ID and ignores duplicate terminal updates. A cross-runtime total order is not asserted when sources do not provide one.

## 11. Lifecycle and retention

The activity store retains at most 1,000 normalized events. Active events remain visible until completion; completed transient nodes remain visible for 12 seconds and remain available in bounded history. Older records are evicted deterministically. Incomplete/truncated rollout data is replayed from the watcher’s safe tail; unsupported or malformed records are ignored.

## 12. Canvas model

Persistent agent nodes and parent-child edges remain visually primary. Observed tool/command/test/patch calls use transient tool nodes and agent-to-artifact edges. File and result artifacts use the existing discovery-node primitive with safe labels. Selecting an agent keeps the workflow visible and shows assignment, parent, children, runtime, unavailable fields, and recent activity. Selecting an artifact shows its safe label, operation, lifecycle, source, status, and duration/exit status only when available.

## 13. Runtime-icon mapping

Role and runtime are separate. `codex` maps to the Codex/OpenAI visual identity, `claude` maps to the Claude identity, and absent or unsupported runtime maps to a neutral generic identity. Names such as Sol, Luna, Terra, Orchestrator, Worker, and Reviewer never select a vendor icon.

## 14. Showcase mode

Showcase mode is inside the existing fullscreen canvas. It uses a 16:9-friendly composition, default privacy-safe labels, hidden raw session IDs, a concise legend, a Live/Replay indicator, fit-all, pause/resume, restart, playback speed controls, and readable operation labels. It does not add synthetic activity or write replay files.

## 15. Replay semantics

Replay is a presentation of the bounded real workflow history already received in memory. It preserves captured timestamps and ordering, does not insert missing steps, and is labeled `Replay`. Restart returns to the first captured event; pause/resume and speed change playback only. A development fixture may be labeled `Demo` for layout tests and cannot be presented as a real workflow.

## 16. Accessibility

Canvas controls are keyboard reachable, have visible focus, and expose labels. Agent and artifact selection has a screen-reader list/details path. Fullscreen traps focus and Escape exits. Reduced motion disables or minimizes nonessential animation while retaining state and labels.

## 17. Performance limits

The activity model is bounded to 1,000 events; the canvas renders only the bounded current workflow and recent visible artifacts. Stable IDs prevent duplicate nodes on replay. No new dependency, disk store, SQLite lookup, or cloud service is required.

## 18. Known limitations

Current Codex and Claude sources do not provide a universal artifact ownership feed, test result contract, review/finding event, or cross-file total order. Generic Codex `exec` wrappers can be shown as observed tool/command activity, but their nested process outcome remains unavailable unless a matching explicit completion/exit record is present. Claude hook and transcript sources can overlap; the existing runtime routing and stable call IDs limit duplicates.

## 19. Manual visual QA procedure

1. Start Agent Flow from this branch with the real relay and webview.
2. Run a real coordinated workflow where Sol delegates separate implementation and validation duties; do not seed synthetic activity.
3. Verify the root/child hierarchy, Codex/Claude/neutral icons, simultaneous children, safe file/command labels, operation edges, returns, and unavailable wording.
4. Select agents and artifacts, use normal fullscreen and Showcase mode, fit, pause, resume, restart, speed, resize, and narrow/wide layouts.
5. Check reduced motion, keyboard focus, Escape, and that no prompt, output, private path, or raw ID appears.
6. Capture only sanitized screenshots when tooling allows. Fauzan’s visual review remains the release gate.

## 20. Future enhancements

Add a runtime-provided artifact feed with explicit file-system effects, command exit status, test result, diff inspection, review/finding, and accepted-return evidence. Add cross-file ordering only when a runtime supplies a trustworthy causal sequence. These are not inferred in Stage 10.

## 21. Packaging status

Desktop packaging remains deferred. Stage 10 does not implement Electron, an installer, auto-update, a packaged application, or a release artifact.
