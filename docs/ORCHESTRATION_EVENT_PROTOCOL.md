# Local orchestration event protocol v1

## Transport and ownership

An external launcher/orchestrator appends one JSON object per line to `<workspace>/.agent-flow/orchestration.jsonl`. Set `AGENT_FLOW_ORCHESTRATION_LOG` to an absolute path or a workspace-relative override. Agent Flow only reads this file. Records are deterministic, replayable, and local. Malformed, unsupported, oversized, expired, duplicate, or conflicting input is ignored or invalidated without creating authority.

Every record requires:

| Field | Meaning |
|---|---|
| `eventId` | Unique idempotency key, at most 256 characters |
| `eventVersion` | `1` |
| `type` | One supported event type |
| `timestamp` | Valid date-time |
| `workflowId` | Authoritative workflow ID |
| `source` | Producer identity/provenance |

Optional `metadata` accepts only `attempt` (non-negative integer), `priority` (short text), `progressPercent` (0–100), and `retryable` (boolean). Keep display text concise. Private or unknown metadata is rejected.

## Event types

| Type | Required type-specific fields |
|---|---|
| `workflow_session_registered` | `workflowName`, `workflowCreatedAt`, `workflowSource`, `sessionId`, `runtime` (`codex` or `claude`); optional `workflowDescription`, `expiresAt` |
| `workflow_started` | `workflowName` |
| `workflow_updated` | at least one of `workflowName`, `workflowDescription`, `status` |
| `workflow_completed` | none |
| `agent_registered` | `agentId`, `agentName`; optional `agentRole`, `sessionId` |
| `agent_status_updated` | `agentId`, `status`; optional bounded `reason` |
| `assignment_created` | `assignmentId`, `assignmentTitle`; optional description, owner, dependencies, status |
| `assignment_started` | `assignmentId`, `agentId` |
| `assignment_updated` | `assignmentId` plus a changed title, description, owner, dependencies, or status |
| `assignment_blocked`, `assignment_completed`, `assignment_failed` | `assignmentId`; optional safe `reason` |
| `delegation_created` | `agentId`, `parentAgentId`; optional session/assignment IDs |
| `dependency_created` | `assignmentId`, non-empty `dependencyIds` |
| `agent_waiting`, `agent_resumed`, `agent_returned` | `agentId`; optional assignment ID/reason |
| `orchestration_message` | `reason` and at least one agent/session/assignment ID |

Workflow and assignment status fields accept `active`, `waiting`, `blocked`, `completed`, and `failed`. `agent_status_updated` also accepts `returned`; its latest valid event controls only that agent's status and optional reason. Agent completion does not complete its workflow. `returned` remains invalid for workflow and assignment records. Self/cyclic delegations and cyclic dependencies are excluded from hierarchy/state. Missing parents stay unresolved. Duplicate event IDs are idempotent. Presentation ordering is timestamp, ingestion index, then event ID; delayed older events do not regress newer entity state.

## Safe PowerShell example

The producer owns IDs and must use the real runtime session ID. This example writes safe fields only:

```powershell
$log = Join-Path $PWD '.agent-flow\orchestration.jsonl'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
function Add-OrchestrationEvent($event) {
  $line = ($event | ConvertTo-Json -Compress) + [Environment]::NewLine
  [IO.File]::AppendAllText($log, $line, [Text.UTF8Encoding]::new($false))
}

$workflow = @{
  eventId = [guid]::NewGuid().ToString()
  eventVersion = 1
  type = 'workflow_started'
  timestamp = [DateTimeOffset]::UtcNow.ToString('o')
  workflowId = 'release-2026-07-17'
  workflowName = 'Release review'
  source = 'local-launcher'
}
Add-OrchestrationEvent $workflow

$membership = @{
  eventId = [guid]::NewGuid().ToString()
  eventVersion = 1
  type = 'workflow_session_registered'
  timestamp = [DateTimeOffset]::UtcNow.ToString('o')
  workflowId = 'release-2026-07-17'
  workflowName = 'Release review'
  workflowCreatedAt = $workflow.timestamp
  workflowSource = 'local-launcher'
  source = 'local-launcher'
  sessionId = '<authoritative-session-id>'
  runtime = 'codex'
}
Add-OrchestrationEvent $membership
```

Do not include prompts, transcript bodies, tool output, tokens, credentials, cookies, environment dumps, or arbitrary metadata. See [Agent Control Room operations](AGENT_CONTROL_ROOM.md) for retention, lifecycle, startup, QA, and limitations.
