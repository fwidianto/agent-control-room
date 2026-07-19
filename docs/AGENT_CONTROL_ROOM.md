# Agent Control Room operations

## Architecture and authority

Claude and Codex watchers emit session lifecycle and activity into the extension or local relay. The relay buffers 5,000 events per session and replays them over SSE. The browser incrementally maintains session summaries, orchestration state, and a bounded workflow timeline; the existing detailed visualizer is mounted only for the selected session.

Workflow identity, agent names, assignments, delegation, and dependencies are authoritative only when accepted from the local [orchestration protocol](ORCHESTRATION_EVENT_PROTOCOL.md). Workspace, timing, prompts, models, and event order never create membership or relationships. Sessions without accepted membership remain under **Ungrouped Sessions**. These optional fork features are isolated behind protocol fields and the sidecar reader, so upstream session and detail behavior remains usable without a sidecar.

## Status semantics

- **Active**: current session activity or explicit active workflow, assignment, or agent state.
- **Waiting**: an explicit wait event or existing session wait signal.
- **Blocked**: an explicit blocked event, optionally with a safe reason.
- **Inactive**: the watcher saw no file activity for five minutes; this is not task success or process termination.
- **Returned**: an explicit agent result-return event.
- **Completed**: explicit assignment or workflow completion only.
- **Failed**: explicit workflow or assignment failure only.
- **Unknown**: authoritative data is absent or insufficient.

Session inactivity, assignment completion, workflow completion, and process termination are separate signals.

## Privacy, retention, and cleanup

Agent Flow reads local Claude/Codex session files and `.agent-flow/orchestration.jsonl` (or `AGENT_FLOW_ORCHESTRATION_LOG`). The control room displays session IDs, runtime/model, workspace, context totals, summarized local activity, and accepted orchestration safe fields.

Do not write prompts, transcripts, tool output, environment dumps, paths containing secrets, tokens, credentials, cookies, or personal data to orchestration records. Unknown fields are ignored; sensitive field names and unsafe metadata reject the complete record. The sidecar is local, gitignored, never uploaded by the control-room feature, and retained until its owner deletes it. Relay session replay is bounded to 5,000 events per session; orchestration acceptance is bounded to 10,000 records and the visible timeline to 5,000 events. Delete `.agent-flow/orchestration.jsonl` to remove local orchestration history; reconnecting rebuilds state from the remaining file.

The published standalone package has separate opt-out aggregate telemetry documented in the README. Development and the extension do not emit it.

## Windows setup and startup

Requirements: Node.js 20+, pnpm, and a supported Claude Code or Codex installation.

```powershell
pnpm.cmd install
pnpm.cmd run setup
$env:AGENT_FLOW_RUNTIME = 'auto'
pnpm.cmd run dev
```

Open `http://127.0.0.1:3000`. `pnpm.cmd run dev` starts both the relay on port 3001 and the web app. To run them separately:

```powershell
$env:AGENT_FLOW_RUNTIME = 'auto'
pnpm.cmd run dev:relay

# In a second PowerShell window
$env:NEXT_PUBLIC_DEMO = '0'
$env:NEXT_PUBLIC_RELAY_PORT = '3001'
pnpm.cmd run dev:web
```

Use `pnpm.cmd run dev:demo` for mock data. macOS/Linux users can use the same scripts with `pnpm`; the native launcher sets development variables on every platform.

## Troubleshooting

- No sessions: confirm the runtime is installed, the workspace is correct, and `AGENT_FLOW_RUNTIME` is `auto`, `codex`, or `claude`.
- No workflow group: confirm the sidecar path, valid JSONL, exact session ID/runtime, unexpired membership, and protocol version 1. Ungrouped is the safe fallback.
- Invalid or expired metadata: inspect only the producer-written sidecar; correct the record and restart/reconnect. Malformed records are skipped.
- Web cannot connect: confirm the relay says `SSE relay on http://127.0.0.1:3001/events` and `NEXT_PUBLIC_RELAY_PORT` is `3001`.
- Port already used: stop the existing local process; the development relay intentionally binds to loopback port 3001.
- Extension packaging: `pnpm.cmd run build:webview`, `pnpm.cmd run build:extension`, then run `pnpm.cmd --filter agent-flow package` only when the `vsce` CLI is already installed. It is not a repository dependency.

## Manual visual QA

1. Show two explicitly grouped sessions, a second workflow with the same display name but different ID, and one ungrouped legacy session.
2. Confirm hierarchy appears only for explicit, complete delegation records; missing parents fall back to a flat list.
3. Exercise Active, Waiting, Blocked, Inactive, Returned, Completed, Failed, and Unknown without treating inactivity as completion.
4. Append delayed and duplicate events; verify stable ordering, idempotency, live updates, and no cross-workflow leakage.
5. Filter the combined timeline by agent, session, assignment, and event type.
6. Open the correct detailed session, return to Overview, and confirm buffered events remain.
7. Check wide, medium, and narrow layouts, long labels/paths, visible keyboard focus, semantic labels, reduced motion, and status text independent of color.
8. Inspect the browser console, SSE connection, relay output, and extension/web logs. Browser QA is a manual release gate when rendering tools are unavailable.

## Contributing and limitations

Keep orchestration changes optional, local-first, versioned, deterministic, and backwards compatible. Add parser and replay tests for contract changes. Never infer authority or add transcript content to events. Run the validation matrix in the requirements document and keep generated data out of commits.

Known limits: version 1 uses an append-only local file, bare session IDs can collide across runtimes, history is bounded and owner-cleaned, no cloud transport exists, visual QA is manual, and `vsce` must be installed separately to create a VSIX. Generic watcher/relay improvements may be proposed upstream; the optional sidecar contract and control-room UI should remain isolated until upstream adopts them.
