import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentSwitchController } from './agent-switch.mjs'

function fixture(options = {}) {
  const source = { agent: 'claude', ready: true, cwd: '/project', text: 'User: original constraints', lastEventAt: Date.now(), lastAssistantText: 'done' }
  const sessions = new Map([['tab-1', source]])
  const releases = [], activations = [], prompts = []
  let sequence = 0, serial = 0
  const adapter = {
    read: async id => sessions.get(id) ?? { ready: false },
    token: () => `nonce-${++serial}`,
    prompt: (context, token) => { prompts.push(context.text); return `AC_HANDOFF_READY:${token}` },
    create: (agent, cwd, prompt) => {
      const id = `child-${++sequence}`
      sessions.set(id, { agent, cwd, ready: !options.stalled, text: 'User: changed direction in Codex', lastEventAt: Date.now(), lastAssistantText: prompt })
      return id
    },
    send: async (id, prompt) => { Object.assign(sessions.get(id), { ready: true, lastEventAt: Date.now(), lastAssistantText: prompt }) },
    activate: (root, id) => activations.push([root, id]),
    release: id => { releases.push(id); sessions.delete(id) },
    exited: () => false,
  }
  return { controller: new AgentSwitchController(adapter, { timeoutMs: 40, pollMs: 2 }), adapter, sessions, releases, activations, prompts }
}

test('A → B → A keeps the same public tab and forwards B’s latest context', async () => {
  const f = fixture()
  assert.deepEqual(await f.controller.switch('tab-1', 'codex'), { ok: true })
  assert.equal(f.controller.active('tab-1'), 'child-1')
  assert.equal(f.controller.blocked('tab-1'), true)
  assert.equal(f.controller.owner('child-1'), 'tab-1')
  assert.equal(f.controller.blocked('child-1'), false)
  assert.deepEqual(await f.controller.switch('tab-1', 'claude'), { ok: true })
  assert.equal(f.controller.active('tab-1'), 'tab-1')
  assert.match(f.prompts[1], /changed direction/)
  assert.equal(f.releases.length, 0)
  assert.equal((await f.controller.state('tab-1')).history.length, 2)
})

test('running source never launches a target', async () => {
  const f = fixture()
  f.sessions.get('tab-1').ready = false
  assert.equal((await f.controller.switch('tab-1', 'codex')).ok, false)
  assert.equal(f.sessions.size, 1)
  assert.equal(f.controller.active('tab-1'), 'tab-1')
})

test('startup failure or missing acknowledgement keeps source intact', async () => {
  const f = fixture({ stalled: true })
  const result = await f.controller.switch('tab-1', 'codex')
  assert.equal(result.ok, false)
  assert.deepEqual(f.releases, ['child-1'])
  assert.equal(f.controller.active('tab-1'), 'tab-1')
  assert.equal(f.sessions.get('tab-1').text, 'User: original constraints')
})

test('a nonce in a user echo is not a final assistant acknowledgement', async () => {
  const f = fixture()
  const create = f.adapter.create
  f.adapter.create = (...args) => { const id = create(...args); Object.assign(f.sessions.get(id), { lastAssistantText: 'other response', text: args[2] }); return id }
  assert.equal((await f.controller.switch('tab-1', 'codex')).ok, false)
  assert.equal(f.activations.length, 0)
})

test('cancel and duplicate request do not destroy source or activate target', async () => {
  const f = fixture({ stalled: true })
  const running = f.controller.switch('tab-1', 'codex')
  assert.equal((await f.controller.switch('tab-1', 'codex')).ok, false)
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal((await f.controller.state('tab-1')).phase, 'preparing')
  assert.equal(f.controller.blocked('tab-1'), true)
  f.controller.cancel('tab-1')
  assert.equal((await running).ok, false)
  assert.equal(f.controller.active('tab-1'), 'tab-1')
  assert.equal(f.activations.length, 0)
})

test('closing while waiting cancels late completion and releases all runtimes', async () => {
  const f = fixture({ stalled: true })
  const running = f.controller.switch('tab-1', 'codex')
  await new Promise(resolve => setTimeout(resolve, 5))
  f.controller.close('tab-1')
  assert.equal((await running).ok, false)
  assert.equal(f.activations.length, 0)
  assert.equal(f.sessions.size, 0)
})

test('cancelled return to an existing session preserves that parked session', async () => {
  const f = fixture()
  await f.controller.switch('tab-1', 'codex')
  f.adapter.send = async id => { f.sessions.get(id).ready = false }
  const returning = f.controller.switch('tab-1', 'claude')
  await new Promise(resolve => setTimeout(resolve, 5))
  f.controller.cancel('tab-1')
  assert.equal((await returning).ok, false)
  assert.equal(f.controller.active('tab-1'), 'child-1')
  assert.equal(f.sessions.has('tab-1'), true)
  assert.equal(f.releases.length, 0)
})


test('completed assistant acknowledgement may include hook explanations but not inline quoted markers', async () => {
  for (const standalone of [true, false]) {
    const f = fixture()
    const create = f.adapter.create
    f.adapter.create = (...args) => {
      const id = create(...args)
      f.sessions.get(id).lastAssistantText = standalone
        ? `Hook explanation.\n\n${args[2]}\n`
        : `The prompt says "${args[2]}".`
      return id
    }
    assert.equal((await f.controller.switch('tab-1', 'codex')).ok, standalone)
  }
})
