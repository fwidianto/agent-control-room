import assert from 'node:assert/strict'
import test from 'node:test'
import { interpretActivity, openSessionDetails, sessionStatus, shortSessionId, summarizeSessionEvents, updateSessionSummary, type SessionSummary } from '../web/lib/session-summary'

const base = (id = 'one'): SessionSummary => ({ id, label: id, status: 'active', startTime: 1, lastActivityTime: 1 })
const event = (type: string, payload: Record<string, unknown> = {}) => ({ time: 1, type, payload })

test('classifies lifecycle and wait status truthfully', () => {
  assert.equal(sessionStatus(base()), 'Active')
  assert.equal(sessionStatus({ ...base(), waiting: true }), 'Waiting')
  assert.equal(sessionStatus({ ...base(), status: 'completed', waiting: true }), 'Inactive')
})

test('interprets activities deterministically', () => {
  assert.equal(interpretActivity(event('tool_call_start', { tool: 'Read', args: 'AGENTS.md' })), 'Reading repository instructions')
  assert.equal(interpretActivity(event('tool_call_start', { tool: 'shell_command', args: 'pnpm.cmd test' })), 'Running tests')
  assert.equal(interpretActivity(event('tool_call_start', { tool: 'shell_command', args: 'pnpm run test' })), 'Running tests')
  assert.equal(interpretActivity(event('tool_call_start', { tool: 'WebSearch' })), 'Performing a web search')
  assert.equal(interpretActivity(event('tool_call_start', { tool: 'exec', args: 'Get-Content web/hooks/use-vscode-bridge.ts' })), 'Inspecting source files')
  assert.equal(interpretActivity(event('tool_call_start', { tool: 'exec', args: 'tools.apply_patch(...)' })), 'Editing a file')
  assert.equal(interpretActivity(event('tool_call_start', { tool: 'exec', args: 'tools.web__run({ search_query: [...] })' })), 'Performing a web search')
  assert.equal(interpretActivity(event('permission_requested')), 'Waiting for another result')
})

test('updates independent sessions and tolerates missing optional data', () => {
  const sessions = [base('one'), base('two')]
  const updated = sessions.map(s => s.id === 'two' ? updateSessionSummary(s, event('model_detected', { model: 'gpt-5' })) : s)
  assert.equal(updated[0].model, undefined)
  assert.equal(updated[1].model, 'gpt-5')
  assert.equal(sessionStatus(updated[0]), 'Active')
})

test('keeps primary session model and context when subagent events arrive', () => {
  const primary = updateSessionSummary(base(), event('model_detected', { agent: 'orchestrator', model: 'gpt-5' }))
  const withContext = updateSessionSummary(primary, event('context_update', { agent: 'orchestrator', tokens: 20, tokensMax: 100 }))
  const afterSubagent = updateSessionSummary(withContext, event('context_update', { agent: 'worker', tokens: 90, tokensMax: 100 }))
  assert.equal(afterSubagent.model, 'gpt-5')
  assert.equal(afterSubagent.tokens, 20)
  assert.equal(afterSubagent.tokensMax, 100)
})

test('builds a new live-session summary from events buffered before session start', () => {
  const summary = summarizeSessionEvents(base(), [
    event('model_detected', { agent: 'orchestrator', model: 'gpt-5' }),
    event('context_update', { agent: 'orchestrator', tokens: 25, tokensMax: 100 }),
    event('tool_call_start', { agent: 'orchestrator', tool: 'Read', args: 'src/index.ts' }),
  ])
  assert.equal(summary.model, 'gpt-5')
  assert.equal(summary.tokens, 25)
  assert.equal(summary.activity, 'Inspecting source files')
})

test('detail navigation uses the selected session id', () => {
  let selected: string | null = null
  let overviewOpen = true
  openSessionDetails('two', id => { selected = id }, () => { overviewOpen = false })
  assert.equal(selected, 'two')
  assert.equal(overviewOpen, false)
})

test('short session IDs distinguish UUIDs created with the same prefix', () => {
  assert.equal(shortSessionId('019f6f02-4bd5-79d2-83f7-15eff5c97b24'), 'f5c97b24')
  assert.equal(shortSessionId('019f6f02-6750-7242-a8ed-781d46c4bb1d'), '46c4bb1d')
})
