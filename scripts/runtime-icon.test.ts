import assert from 'node:assert/strict'
import test from 'node:test'
import { runtimeIcon } from '../web/lib/runtime-icon'

test('maps Codex to OpenAI icon identity', () => assert.equal(runtimeIcon('codex'), 'codex'))
test('maps Claude to Claude icon identity', () => assert.equal(runtimeIcon('claude'), 'claude'))
test('maps absent and unsupported runtimes to neutral identity', () => {
  assert.equal(runtimeIcon(undefined), 'neutral')
  assert.equal(runtimeIcon('Sol'), 'neutral')
  assert.equal(runtimeIcon('Reviewer'), 'neutral')
})
