import assert from 'node:assert/strict'
import test from 'node:test'
import { interpretActivity, openSessionDetails, sessionStatus, updateSessionSummary, type SessionSummary } from '../web/lib/session-summary'

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

test('detail navigation uses the selected session id', () => {
  let selected: string | null = null
  let overviewOpen = true
  openSessionDetails('two', id => { selected = id }, () => { overviewOpen = false })
  assert.equal(selected, 'two')
  assert.equal(overviewOpen, false)
})
