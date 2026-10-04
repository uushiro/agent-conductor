import test from 'node:test'
import assert from 'node:assert/strict'
import { HandoffDrafts } from './handoff-draft.mjs'

test('draft survives target failure/change and sends only once to the explicitly observed target', async () => {
  let target = { ready: false, agent: 'claude', token: 'A' }, writes = []
  const store = new HandoffDrafts({ destination: async () => target, write: (...args) => writes.push(args) })
  const draft = store.set('tab', '次の依頼\n条件は保持')
  assert.equal((await store.submit('tab', draft.revision, 'A')).ok, false)
  target = { ready: true, agent: 'codex', token: 'B' }
  assert.equal((await store.submit('tab', draft.revision, 'A')).ok, false)
  assert.equal(store.get('tab').text, draft.text)
  assert.equal((await store.submit('tab', draft.revision, 'B')).ok, true)
  assert.equal((await store.submit('tab', draft.revision, 'B')).ok, false)
  assert.equal(writes.length, 1)
  assert.equal(store.get('tab').text, '')
})
test('concurrent submit and edits cannot clear a newer draft; tabs stay separate', async () => {
  let resolve; const writes = []
  const store = new HandoffDrafts({ destination: () => new Promise(done => { resolve = done }), write: (...args) => writes.push(args) })
  const first = store.set('A', 'first'); store.set('B', 'other tab')
  const pending = store.submit('A', first.revision, 'target')
  assert.equal(store.busy('A'), true)
  assert.equal((await store.submit('A', first.revision, 'target')).ok, false)
  store.set('A', 'newer')
  resolve({ ready: true, token: 'target' })
  assert.equal((await pending).ok, false)
  assert.equal(store.get('A').text, 'newer')
  assert.equal(store.get('B').text, 'other tab')
  assert.equal(writes.length, 0)
  assert.throws(() => store.set('A', 'escape\x1bcommand'))
})
