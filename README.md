# Agent Control Room

A personal Codex-oriented extension of [Simon Patole's Agent Flow](https://github.com/patoles/agent-flow), focused on making multi-agent work observable without inventing relationships or lifecycle state.

This repository intentionally preserves the upstream Apache-2.0 license, attribution, trademark notices, package identifiers, and much of the original runtime structure. The repository name **Agent Control Room** identifies this fork and its added control-room capabilities; it is not a rename of the upstream Agent Flow project or trademark.

## What this fork adds

On top of Agent Flow's local Claude Code / Codex visualization, this fork adds:

- **Aggregate control room** — see detected sessions together before opening a detailed session.
- **Explicit workflow identity** — group sessions only when authoritative orchestration data says they belong together.
- **Native Codex multi-agent bridge** — map Codex parent/child relationships from explicit rollout metadata rather than timing, workspace similarity, or guessed names.
- **Workflow topology** — show authoritative delegation relationships and agent state in a multi-agent canvas.
- **Truthful lifecycle semantics** — returned control is not treated as successful completion; unknown states remain unknown.
- **Replay and reconnect safety** — deterministic event identity and deduplication protect the view across replay/restart.
- **Windows-friendly development path** — validated with the local Codex workflow used for this fork.

The current `main` branch is the accepted Stage-8 checkpoint. Later packaged-app and live-agent/artifact experiments are not part of `main` unless explicitly reviewed and merged.

## Scope boundary

Agent Control Room is an observability and control-room layer. It does not autonomously orchestrate agents, infer hidden relationships, decide whether work succeeded, or replace the underlying Claude Code / Codex runtimes.

Relationships are accepted only from explicit sources such as the local orchestration protocol or native Codex rollout metadata. Unsupported lifecycle states remain neutral rather than being guessed.

## Run this fork from source

Requirements:

- Node.js 20+
- pnpm
- Claude Code and/or Codex CLI, depending on the runtime you want to observe

```bash
git clone https://github.com/fwidianto/agent-control-room.git
cd agent-control-room
pnpm i
pnpm run dev
```

On Windows PowerShell, use `pnpm.cmd` where needed.

Useful commands:

```bash
pnpm run dev:demo
pnpm run dev:relay
pnpm run dev:extension
pnpm run build:web
pnpm run build:extension
pnpm run build:all
pnpm test
```

The existing upstream-compatible settings and environment names remain in place, including `agentVisualizer.*`, `AGENT_FLOW_RUNTIME`, and `CODEX_HOME`.

## Runtime behavior

By default the application can observe Claude Code and Codex sessions concurrently. Runtime selection can be restricted using the existing Agent Flow-compatible configuration.

For Codex, the fork reads local rollout JSONL and uses only explicit native metadata for workflow membership and parent/child relationships. It does not require patching Codex, installing a Codex hook, or reading private assignment text into the control-room event stream.

For manually supplied workflow grouping, see:

- [Agent Control Room operations](docs/AGENT_CONTROL_ROOM.md)
- [Orchestration Event Protocol v1](docs/ORCHESTRATION_EVENT_PROTOCOL.md)
- [Stage-8 native Codex bridge evidence](docs/STAGE_8_NATIVE_CODEX_BRIDGE.md)

## Development

The repository remains structurally close to upstream Agent Flow:

- `web/` — Next.js visualization UI
- `extension/` — VS Code-compatible extension and runtime watchers
- `scripts/` — local relay, setup, tests, and development helpers
- `app/` — standalone application packaging inherited from upstream
- `docs/` — current fork-specific technical documentation

Use the existing CI and test suite for changes. Keep runtime semantics conservative: if a state, relationship, or result cannot be proven from an authoritative event, do not fabricate it for presentation.

## Upstream relationship

This fork is based on **Agent Flow** by [Simon Patole](https://github.com/patoles). Upstream project, documentation, releases, and published package remain under the Agent Flow identity.

This fork exists because the local workflow needed deeper Codex multi-agent observability and an aggregate control-room view. Upstream attribution is preserved; fork-specific changes are maintained here.

## Privacy

The fork retains upstream Agent Flow's local-first architecture and telemetry implementation. Source development (`pnpm run dev`) and the VS Code extension do not emit the upstream standalone-app telemetry described by Agent Flow. Review the inherited telemetry code and upstream documentation before publishing or distributing a standalone build.

## License and trademark

Apache License 2.0 — see [LICENSE](LICENSE).

Original Agent Flow authorship and attribution belong to [Simon Patole](https://github.com/patoles). The name **Agent Flow** and its associated logos are trademarks of Simon Patole; see [TRADEMARK.md](TRADEMARK.md).

**Agent Control Room** is the name used for this personal fork and its added control-room functionality.
