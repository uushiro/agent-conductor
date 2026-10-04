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
  assert.deepEqual(f.releases, [])
  assert.equal(f.controller.recoveryRuntime('tab-1'), 'child-1')
  assert.deepEqual((await f.controller.state('tab-1')).recovery, { agent: 'codex', exited: false })
  assert.equal(f.controller.active('tab-1'), 'tab-1')
  assert.equal(f.sessions.get('tab-1').text, 'User: original constraints')
})

test('progress stays starting until adapter observes startup, then records dispatch timing', async () => {
  const f = fixture()
  let started = false
  const create = f.adapter.create
  f.adapter.create = (...args) => { const id = create(...args); Object.assign(f.sessions.get(id), { text: '', ready: false }); return id }
  f.adapter.status = async () => ({ started })
  const running = f.controller.switch('tab-1', 'codex')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal((await f.controller.state('tab-1')).progress?.stage, 'starting')
  started = true; f.sessions.get('child-1').ready = true
  assert.equal((await running).ok, true)
  const metric = f.controller.metrics().at(-1)
  assert.equal(metric.outcome, 'success')
  assert.equal(metric.mode, 'new')
  assert.ok(metric.durations.totalMs >= metric.durations.readMs)
  assert.equal(metric.durations.readMs + metric.durations.startMs + metric.durations.waitMs + metric.durations.activateMs, metric.durations.totalMs)
  assert.equal('cwd' in metric, false)
})

test('a transcript observation can advance startup when native status is still generic', async () => {
  const f = fixture()
  f.adapter.status = async () => ({ started: false })
  assert.equal((await f.controller.switch('tab-1', 'codex')).ok, true)
})

test('preflight failure prevents a fresh spawn and reports its code', async () => {
  const f = fixture()
  let creates = 0
  const create = f.adapter.create
  f.adapter.create = (...args) => { creates += 1; return create(...args) }
  f.adapter.preflight = async () => { const error = new Error('Codex is unavailable'); error.code = 'missing_cli'; throw error }
  const result = await f.controller.switch('tab-1', 'codex')
  assert.equal(result.errorCode, 'missing_cli')
  assert.equal(creates, 0)
  assert.equal(f.controller.metrics().at(-1).errorCode, 'missing_cli')
})

test('cancelling while preflight rejects is classified as cancelled and never spawns', async () => {
  const f = fixture()
  let reject
  f.adapter.preflight = () => new Promise((_, fail) => { reject = fail })
  const running = f.controller.switch('tab-1', 'codex')
  await new Promise(resolve => setTimeout(resolve, 1))
  f.controller.cancel('tab-1')
  const error = new Error('missing cli'); error.code = 'missing_cli'; reject(error)
  assert.equal((await running).errorCode, 'cancelled')
  assert.equal(f.sessions.size, 1)
})

test('timeout retains a new target and retry reuses it with a fresh nonce', async () => {
  const f = fixture({ stalled: true })
  const first = await f.controller.switch('tab-1', 'codex')
  assert.equal(first.errorCode, 'timeout')
  assert.equal(f.controller.recoveryRuntime('tab-1'), 'child-1')
  Object.assign(f.sessions.get('child-1'), { ready: true })
  const second = await f.controller.switch('tab-1', 'codex')
  assert.equal(second.ok, true)
  assert.equal(f.sessions.has('child-2'), false)
  assert.equal(f.controller.metrics().at(-1).mode, 'reuse')
})

test('recovery is inaccessible while its retry is pending', async () => {
  const f = fixture({ stalled: true })
  await f.controller.switch('tab-1', 'codex')
  Object.assign(f.sessions.get('child-1'), { ready: true })
  f.adapter.send = async id => { Object.assign(f.sessions.get(id), { ready: false }) }
  const retry = f.controller.switch('tab-1', 'codex')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(f.controller.recoveryRuntime('tab-1'), null)
  assert.equal((await f.controller.state('tab-1')).recovery, null)
  f.controller.cancel('tab-1')
  await retry
  assert.equal(f.controller.recoveryRuntime('tab-1'), 'child-1')
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
  assert.equal(f.controller.metrics().at(-1).outcome, 'cancelled')
  assert.deepEqual(f.releases, ['child-1'])
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
  assert.equal(f.controller.recoveryRuntime('tab-1'), null)
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

test('restored virtual parked lineage is resumed through the adapter instead of spawning a latest session', async () => {
  const f = fixture()
  let restored = 0, created = 0, sends = 0
  const create = f.adapter.create
  f.adapter.create = (...args) => { created += 1; return create(...args) }
  f.adapter.send = async () => { sends += 1 }
  f.adapter.restoreParked = async (_logical, descriptor, prompt, token) => {
    restored += 1
    assert.equal(descriptor.sessionId, 'parked-codex')
    assert.equal(prompt, `AC_HANDOFF_READY:${token}`)
    f.sessions.set('restored-codex', { agent: 'codex', cwd: '/project', ready: true, text: 'parked context', lastEventAt: Date.now(), lastAssistantText: prompt })
    return { runtime: 'restored-codex' }
  }
  f.controller.restoreLineage('tab-1', { parked: [{ agent: 'codex', sessionId: 'parked-codex', cwd: '/project' }] })
  assert.equal((await f.controller.switch('tab-1', 'codex')).ok, true)
  assert.equal(restored, 1); assert.equal(created, 0); assert.equal(sends, 0, 'adapter owns safe direct initial prompt delivery'); assert.equal(f.controller.active('tab-1'), 'restored-codex')
})

test('exited restored parked runtime retries the exact descriptor instead of creating a replacement', async () => {
  const f = fixture(); let restores = 0, creates = 0; const exited = new Set()
  f.adapter.create = () => { creates += 1; return 'unexpected-new' }
  f.adapter.exited = id => exited.has(id)
  f.adapter.restoreParked = async (_id, descriptor, prompt) => {
    restores += 1; assert.equal(descriptor.sessionId, 'parked-codex')
    const runtime = `restored-${restores}`
    f.sessions.set(runtime, { agent: 'codex', cwd: '/project', ready: true, text: 'parked', lastEventAt: Date.now(), lastAssistantText: restores === 1 ? '' : prompt })
    if (restores === 1) exited.add(runtime)
    return { runtime }
  }
  f.controller.restoreLineage('tab-1', { parked: [{ agent: 'codex', sessionId: 'parked-codex', cwd: '/project' }] })
  assert.equal((await f.controller.switch('tab-1', 'codex')).errorCode, 'target_exited')
  assert.equal((await f.controller.switch('tab-1', 'codex')).ok, true)
  assert.equal(restores, 2); assert.equal(creates, 0)
})

test('parked descriptor survives timeout and cancel, while a ready recovery is reused', async () => {
  const f = fixture(); let restores = 0, sends = 0
  f.adapter.restoreParked = async (_id, descriptor) => {
    restores += 1; assert.equal(descriptor.sessionId, 'parked-codex')
    f.sessions.set('restored', { agent: 'codex', cwd: '/project', ready: true, text: 'parked', lastEventAt: Date.now(), lastAssistantText: '' })
    return { runtime: 'restored' }
  }
  f.adapter.send = async (id, prompt) => { sends += 1; Object.assign(f.sessions.get(id), { lastEventAt: Date.now(), lastAssistantText: prompt }) }
  f.controller.restoreLineage('tab-1', { parked: [{ agent: 'codex', sessionId: 'parked-codex', cwd: '/project' }] })
  assert.equal((await f.controller.switch('tab-1', 'codex')).errorCode, 'timeout')
  assert.ok(f.controller.groups.get('tab-1').parked.has('codex'))
  assert.equal((await f.controller.switch('tab-1', 'codex')).ok, true)
  assert.equal(restores, 1); assert.equal(sends, 1)

  const g = fixture(); let cancelRestores = 0
  g.adapter.restoreParked = async () => { cancelRestores += 1; g.sessions.set('restored', { agent: 'codex', cwd: '/project', ready: false, text: '', lastEventAt: 0, lastAssistantText: '' }); return { runtime: 'restored' } }
  g.controller.restoreLineage('tab-1', { parked: [{ agent: 'codex', sessionId: 'parked-codex', cwd: '/project' }] })
  const pending = g.controller.switch('tab-1', 'codex'); await new Promise(resolve => setTimeout(resolve, 5)); g.controller.cancel('tab-1')
  assert.equal((await pending).errorCode, 'cancelled'); assert.equal(cancelRestores, 1); assert.ok(g.controller.groups.get('tab-1').parked.has('codex'))
})
