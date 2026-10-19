import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { uniquePendingGravityTab } from './session-resume.mjs'

function harness() {
  const source = fs.readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  const start = source.indexOf('function startGravitySessionWatch(')
  const end = source.indexOf('// --- Codex session helpers ---', start)
  const intervals = new Set()
  const timeouts = []
  let latest = 'previous'
  const context = {
    path, console,
    uniquePendingGravityTab,
    getLastGravityConversationId: () => latest,
    tabInfo: new Map(['a', 'b'].map(id => [id, { gravityConversationId: null }])),
    tabGravitySessionWatchers: new Map(),
    tabGravitySessionWatcherCwds: new Map(),
    tabGravitySessionAmbiguous: new Set(),
    setInterval: fn => { intervals.add(fn); return fn },
    clearInterval: fn => intervals.delete(fn),
    setTimeout: fn => timeouts.push(fn),
  }
  vm.createContext(context)
  vm.runInContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return { ...context, setLatest: id => { latest = id }, tick: () => [...intervals].forEach(fn => fn()), expire: () => timeouts.splice(0).forEach(fn => fn()) }
}

test('Gravity collision stays blocked after input restarts and late peer creation', () => {
  const h = harness()
  h.startGravitySessionWatch('a', '/same')
  h.startGravitySessionWatch('b', '/same')
  h.setLatest('conversation-a'); h.tick()
  h.startGravitySessionWatch('a', '/same')
  h.setLatest('conversation-b'); h.tick()
  h.expire()
  h.startGravitySessionWatch('a', '/same'); h.tick()
  for (const info of h.tabInfo.values()) assert.equal(info.gravityConversationId, null)
  assert.equal(h.tabGravitySessionWatchers.size, 0)
})

test('Expired Gravity ownership still prevents binding another live tab', () => {
  const h = harness()
  h.startGravitySessionWatch('a', '/same'); h.expire()
  h.startGravitySessionWatch('b', '/same')
  h.setLatest('late-a'); h.tick()
  assert.equal(h.tabInfo.get('b').gravityConversationId, null)
})

test('Single Gravity tab can observe a conversation after a delayed first input', () => {
  const h = harness()
  h.startGravitySessionWatch('a', '/same'); h.expire()
  h.startGravitySessionWatch('a', '/same')
  h.setLatest('conversation-a'); h.tick()
  assert.equal(h.tabInfo.get('a').gravityConversationId, 'conversation-a')
})
