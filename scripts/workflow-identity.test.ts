import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { enrichSessionList, MAX_WORKFLOW_DIAGNOSTICS, MAX_WORKFLOW_LINE_BYTES, parseWorkflowSessionRecord, resolveWorkflowLogPath, WorkflowIdentityReader } from '../extension/src/workflow-identity'
import { groupSessionsByWorkflow, mergeSessionList, type SessionSummary } from '../web/lib/session-summary'

const now = Date.parse('2026-07-17T00:00:00.000Z')
const record = (overrides: Record<string, unknown> = {}) => ({
  eventId: 'event-1', eventVersion: 1, type: 'workflow_session_registered',
  timestamp: '2026-07-16T23:00:00.000Z', source: 'launcher',
  workflowId: 'workflow-1', workflowName: 'Release', workflowCreatedAt: '2026-07-16T22:00:00.000Z',
  workflowSource: 'local launcher', sessionId: 'session-1', runtime: 'codex',
  ...overrides,
})
const session = (id: string, workflow?: SessionSummary['workflow']): SessionSummary => ({
  id, label: id, status: 'active', startTime: now, lastActivityTime: now, runtime: 'codex', workspace: 'C:\\repo', ...(workflow ? { workflow } : {}),
})

test('accepts only valid, current version-1 workflow registration records', () => {
  assert.ok(parseWorkflowSessionRecord(record(), now))
  assert.equal(parseWorkflowSessionRecord(record({ eventVersion: 2 }), now), null)
  assert.equal(parseWorkflowSessionRecord(record({ type: 'agent_registered' }), now), null)
  assert.equal(parseWorkflowSessionRecord(record({ workflowName: '' }), now), null)
  assert.equal(parseWorkflowSessionRecord(record({ expiresAt: '2026-07-16T00:00:00.000Z' }), now), null)
  assert.equal(parseWorkflowSessionRecord(record({ runtime: 'other' }), now), null)
})

test('tails explicit registrations, ignores malformed and duplicate events, and fails closed on conflicts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-flow-workflow-'))
  const file = join(dir, 'orchestration.jsonl')
  try {
    writeFileSync(file, `${JSON.stringify(record())}\nnot-json\n${JSON.stringify(record({ eventId: 'unsupported', eventVersion: 2, sessionId: 'unsupported-session' }))}\n`)
    const reader = new WorkflowIdentityReader(file)
    assert.equal(reader.refresh(now), true)
    assert.equal(reader.get('session-1', 'codex', now)?.workflowId, 'workflow-1')
    assert.equal(reader.get('session-1', 'claude', now), undefined)

    appendFileSync(file, `${JSON.stringify(record())}\n`)
    assert.equal(reader.refresh(now), false)
    appendFileSync(file, `${JSON.stringify(record({ eventId: 'event-2', workflowId: 'workflow-2' }))}\n`)
    assert.equal(reader.refresh(now), true)
    assert.equal(reader.get('session-1', 'codex', now), undefined)
    assert.equal(reader.getMetadataStatus('session-1', 'codex'), 'invalid')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('reload reconstructs workflow identity and expired membership disappears', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-flow-replay-'))
  const file = join(dir, 'orchestration.jsonl')
  try {
    writeFileSync(file, `${JSON.stringify(record({ expiresAt: '2026-07-17T00:01:00.000Z' }))}\n`)
    const first = new WorkflowIdentityReader(file)
    first.refresh(now)
    const replay = new WorkflowIdentityReader(file)
    replay.refresh(now)
    assert.deepEqual(replay.get('session-1', 'codex', now), first.get('session-1', 'codex', now))
    assert.equal(replay.refresh(now + 61_000), true)
    assert.equal(replay.get('session-1', 'codex', now + 61_000), undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('conflicting definitions invalidate every membership for that workflow', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-flow-conflict-'))
  const file = join(dir, 'orchestration.jsonl')
  try {
    writeFileSync(file, [
      record(),
      record({ eventId: 'event-2', sessionId: 'session-2', workflowName: 'Conflicting name' }),
    ].map(value => JSON.stringify(value)).join('\n') + '\n')
    const reader = new WorkflowIdentityReader(file)
    reader.refresh(now)
    assert.equal(reader.get('session-1', 'codex', now), undefined)
    assert.equal(reader.get('session-2', 'codex', now), undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('resolves the workspace-local log and explicit override', () => {
  assert.equal(resolveWorkflowLogPath('C:\\repo', undefined), join('C:\\repo', '.agent-flow', 'orchestration.jsonl'))
  assert.equal(resolveWorkflowLogPath('C:\\repo', 'runtime/events.jsonl'), join('C:\\repo', 'runtime/events.jsonl'))
})

test('groups only explicit identity, preserves duplicate names and legacy sessions', () => {
  const workflow = {
    workflowId: 'workflow-1', workflowName: 'Same name', workflowCreatedAt: '2026-07-16T22:00:00.000Z',
    workflowSource: 'launcher', provenance: 'Explicit orchestration event' as const,
  }
  const grouped = groupSessionsByWorkflow([
    session('one', workflow),
    session('one-b', workflow),
    session('two', { ...workflow, workflowId: 'workflow-2' }),
    session('legacy-one'),
    { ...session('legacy-two'), workspace: 'C:\\repo' },
  ])
  assert.equal(grouped.workflows.length, 2)
  assert.deepEqual(grouped.workflows.map(group => group.sessions.map(item => item.id)), [['one', 'one-b'], ['two']])
  assert.deepEqual(grouped.ungrouped.map(item => item.id), ['legacy-one', 'legacy-two'])
})

test('live identity updates preserve derived activity and remove expired membership', () => {
  const current = { ...session('one'), activity: 'Searching the codebase', model: 'gpt-5' }
  const workflow = {
    workflowId: 'workflow-1', workflowName: 'Release', workflowCreatedAt: '2026-07-16T22:00:00.000Z',
    workflowSource: 'launcher', provenance: 'Explicit orchestration event' as const,
  }
  const grouped = mergeSessionList([current], [{ ...session('one'), workflow }])[0]
  assert.equal(grouped.workflow?.workflowId, 'workflow-1')
  assert.equal(grouped.activity, 'Searching the codebase')
  assert.equal(grouped.model, 'gpt-5')
  assert.equal(mergeSessionList([grouped], [session('one')])[0].workflow, undefined)
})

test('bounds diagnostics and fails closed on oversized input without exposing record contents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-flow-bounds-'))
  const file = join(dir, 'orchestration.jsonl')
  try {
    writeFileSync(file, `${'x'.repeat(MAX_WORKFLOW_LINE_BYTES + 1)}\n`)
    const reader = new WorkflowIdentityReader(file)
    reader.refresh(now)
    assert.deepEqual(reader.getDiagnostics(), [{ code: 'overflow' }])

    writeFileSync(file, Array.from({ length: MAX_WORKFLOW_DIAGNOSTICS + 5 }, () => 'not-json').join('\n') + '\n')
    reader.refresh(now)
    assert.equal(reader.getDiagnostics().length, MAX_WORKFLOW_DIAGNOSTICS)
    assert.ok(reader.getDiagnostics().every(item => Object.keys(item).every(key => ['code', 'sessionId', 'runtime'].includes(key))))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('serialized session-list protocol preserves summaries across registration, removal, expiry, and reconnect', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-flow-protocol-'))
  const file = join(dir, 'orchestration.jsonl')
  const current = { ...session('session-1'), activity: 'Searching the codebase', model: 'gpt-5' }
  const protocolNow = Date.now()
  const expiresAt = new Date(protocolNow + 60_000).toISOString()
  const roundTrip = (reader: WorkflowIdentityReader) => {
    const message = JSON.stringify({ type: 'session-list', sessions: enrichSessionList(reader, [session('session-1')]) })
    return mergeSessionList([current], JSON.parse(message).sessions)[0]
  }
  try {
    writeFileSync(file, '')
    const live = new WorkflowIdentityReader(file)
    live.refresh(protocolNow)
    assert.equal(roundTrip(live).workflow, undefined)

    appendFileSync(file, `${JSON.stringify(record({ expiresAt }))}\n`)
    live.refresh(protocolNow)
    assert.equal(roundTrip(live).workflow?.workflowId, 'workflow-1')
    assert.equal(roundTrip(live).activity, 'Searching the codebase')

    const reconnect = new WorkflowIdentityReader(file)
    reconnect.refresh(protocolNow)
    assert.equal(roundTrip(reconnect).workflow?.workflowId, 'workflow-1')

    reconnect.refresh(protocolNow + 61_000)
    assert.equal(roundTrip(reconnect).workflow, undefined)
    assert.equal(roundTrip(reconnect).workflowMetadataStatus, 'expired')

    rmSync(file)
    reconnect.refresh(protocolNow + 62_000)
    assert.equal(roundTrip(reconnect).workflowMetadataStatus, undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
