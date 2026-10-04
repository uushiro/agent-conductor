import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

// Runs the built main process with synthetic CLI transcripts and PTYs. Never
// starts Electron, a shell, an LLM, or a network request; user files are untouched.
test('main IPC keeps logical tab, title, sidebar, persistence and input routing across A→B→A', async () => {
  const require = createRequire(import.meta.url)
  const { build } = require('esbuild')
  const bundled = await build({ entryPoints: [new URL('./main.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'node-pty'], logLevel: 'silent' })
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-ipc-test-'))
  const project = path.join(testHome, 'project')
  fs.mkdirSync(project)
  const handlers = new Map(), events = new Map(), intervals = new Map(), sent = [], ptys = [], timeouts = new Set(), longTimeouts = []
  const sourceId = randomUUID()
  const sourcePath = path.join(testHome, '.claude/projects', project.replaceAll('/', '-'), sourceId + '.jsonl')
  const stamp = () => new Date().toISOString()
  const append = (file, records) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, records.map(JSON.stringify).join('\n') + '\n') }
  append(sourcePath, [
    { type: 'user', sessionId: sourceId, cwd: project, timestamp: stamp(), message: { role: 'user', content: 'Keep the approved scope; do not delete files.' } },
    { type: 'assistant', sessionId: sourceId, cwd: project, timestamp: stamp(), message: { role: 'assistant', content: [{ type: 'text', text: 'First phase done.' }], stop_reason: 'end_turn' } },
  ])
  let missingCli = false, stallNextSend = false, clockOffset = 0
  class TestDate extends Date { static now() { return Date.now() + clockOffset } }
  let ready
  const appReady = new Promise(resolve => { ready = resolve })
  const fakeElectron = {
    app: { getPath: () => testHome, setPath() {}, whenReady: () => ({ then(fn) { fn(); ready() } }), on() {}, getVersion: () => '0.0.0' },
    BrowserWindow: class {
      static getAllWindows() { return [] }
      constructor() { this.webContents = { send: (...args) => sent.push(args) } }
      on() {} loadFile() {} loadURL() {}
    },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => events.set(name, fn) },
    shell: {}, clipboard: {}, dialog: {}, nativeImage: {},
  }
  const fakePty = {
    spawn(shell, args, options) {
      const proc = { process: options.env.AC_HANDOFF_PROMPT ? 'codex' : 'zsh', writes: [], killed: false,
        onData(fn) { this.data = fn }, onExit(fn) { this.exit = fn }, resize() {},
        kill() { this.killed = true; this.exit?.() },
        write(data) {
          this.writes.push(data)
          if (this.complete && data === 'complete-setup\r') { setTimeout(() => this.complete(this.pendingPrompt), 5); return }
          if (/^claude(?:\s|$)/.test(data)) this.process = 'claude'
          if (data.includes('\x1b[200~')) {
            const marker = data.match(/AC_HANDOFF_READY:([a-z0-9-]+)/)?.[0]
            if (marker && this.complete) {
              if (stallNextSend) {
                stallNextSend = false; this.pendingPrompt = data
                append(this.rollout, [{ type: 'response_item', timestamp: stamp(), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: data }] } }])
                setTimeout(() => { clockOffset = 61000; this.data?.('Workspace trust confirmation required\r\n') }, 5)
              } else setTimeout(() => this.complete(data), 5)
            }
            if (marker && this === ptys[0]) {
              setTimeout(() => append(sourcePath, [
                { type: 'user', timestamp: stamp(), message: { role: 'user', content: data } },
                { type: 'assistant', timestamp: stamp(), message: { role: 'assistant', content: [{ type: 'text', text: marker }], stop_reason: 'end_turn' } },
              ]), 5)
            }
          }
        },
      }
      ptys.push(proc)
      if (options.env.AC_HANDOFF_PROMPT) {
        assert.match(args[1], /exec codex "\$ac_prompt"/)
        const id = randomUUID(), date = new Date()
        const rollout = path.join(testHome, '.codex/sessions', String(date.getFullYear()), String(date.getMonth()+1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'), `rollout-test-${id}.jsonl`)
        const prompt = options.env.AC_HANDOFF_PROMPT
        proc.rollout = rollout
        proc.complete = (receivedPrompt) => {
          append(rollout, [
            { type: 'session_meta', timestamp: stamp(), payload: { id, cwd: project, source: 'cli', originator: 'codex_cli_rs' } },
            { type: 'response_item', timestamp: stamp(), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: receivedPrompt }] } },
            { type: 'response_item', timestamp: stamp(), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: receivedPrompt.match(/AC_HANDOFF_READY:[a-z0-9-]+/)[0] }] } },
            { type: 'event_msg', timestamp: stamp(), payload: { type: 'task_complete' } },
          ])
          proc.data?.('Codex ready\r\n')
        }
        setTimeout(() => proc.complete(prompt), 5)
      }
      return proc
    },
  }
  const fakeRequire = name => {
    if (name === 'electron') return fakeElectron
    if (name === 'node-pty') return fakePty
    if (name === 'node:os') return { ...os, homedir: () => testHome }
    if (name === 'node:child_process') return { execFile(command, args, options, callback) {
      assert.equal(args[1], 'command -v "$1" >/dev/null', 'tests must never execute a real child process')
      setTimeout(() => callback(missingCli ? Object.assign(new Error('not found'), { code: 1 }) : null, '', ''), 1)
    } }
    if (name === 'node:https') return { get() { throw new Error('Network forbidden in test') } }
    return require(name)
  }
  const context = {
    require: fakeRequire, exports: {}, module: { exports: {} }, __dirname: path.join(testHome, 'bundle'),
    Date: TestDate,
    process: { env: { SHELL: '/bin/zsh' }, platform: process.platform }, Buffer, console,
    setInterval(fn, ms) { const key = {}; intervals.set(key, { fn, ms }); return key },
    clearInterval(key) { intervals.delete(key) },
    setTimeout(fn, ms) { if (ms >= 1000) { longTimeouts.push({ fn, ms }); return {} }; const handle = setTimeout(fn, 2); timeouts.add(handle); return handle },
    clearTimeout(handle) { clearTimeout(handle); timeouts.delete(handle) },
  }
  try {
    vm.runInNewContext(bundled.outputFiles[0].text, context)
    await appReady
    const invoke = (name, ...args) => handlers.get(name)({}, ...args)
    const emit = (name, ...args) => events.get(name)({}, ...args)
    const root = await invoke('terminal:create', project, sourceId, 'claude')
    emit('terminal:input', root, `claude --resume ${sourceId}\r`)
    for (const timer of intervals.values()) if (timer.ms === 1500) timer.fn()
    await invoke('terminal:set-issue', root, 'My task')
    assert.equal((await invoke('terminal:agent-switch-state', root)).canSwitch, true)
    missingCli = true
    const missing = await invoke('terminal:switch-agent', root, 'codex')
    assert.equal(missing.errorCode, 'cli_missing')
    assert.equal(ptys.length, 1, 'missing CLI never starts another PTY')
    assert.equal((await invoke('terminal:agent-switch-state', root)).canSwitch, true)
    missingCli = false
    const watchdog = setTimeout(() => invoke('terminal:cancel-agent-switch', root), 2500)
    const switched = await invoke('terminal:switch-agent', root, 'codex')
    clearTimeout(watchdog)
    assert.equal(switched.ok, true, switched.error)
    assert.equal((await invoke('terminal:agent-switch-state', root)).agent, 'codex')
    assert.equal((await invoke('terminal:list-info')).length, 1)
    assert.equal((await invoke('terminal:list-info'))[0].id, root)
    assert.equal(sent.filter(e => e[0] === 'terminal:reset')[0][1], root)
    const reset = sent.find(e => e[0] === 'terminal:reset')
    emit('terminal:agent-switch-rendered', root, 'stale-token')
    assert.equal((await invoke('terminal:agent-switch-metrics')).at(-1).durations.rendererMs, undefined)
    emit('terminal:agent-switch-rendered', root, reset[3])
    const metrics = await invoke('terminal:agent-switch-metrics')
    assert.equal(metrics.length, 2)
    assert.ok(metrics.at(-1).durations.rendererMs >= 0)
    assert.doesNotMatch(JSON.stringify(metrics), /Keep the approved|project|tab-1|AC_HANDOFF_READY/)
    assert.ok(fs.existsSync(path.join(testHome, 'handoff-metrics.json')))
    const saved = JSON.parse(fs.readFileSync(path.join(testHome, 'session.json'), 'utf8'))
    assert.equal(saved.tabs.length, 1)
    assert.equal(saved.tabs[0].hadCodex, true)
    await invoke('terminal:set-issue', root, 'Renamed task')
    const returnWatchdog = setTimeout(() => invoke('terminal:cancel-agent-switch', root), 2500)
    const returned = await invoke('terminal:switch-agent', root, 'claude')
    clearTimeout(returnWatchdog)
    assert.equal(returned.ok, true, returned.error)
    assert.equal((await invoke('terminal:get-title', root)).issue, 'Renamed task')
    assert.equal(ptys.length, 2, 'return reuses source runtime')
    assert.equal(ptys[0].killed, false)
    const before = ptys[0].writes.length
    emit('terminal:input', root, 'next question')
    assert.equal(ptys[0].writes.length, before + 1)
    assert.equal((await invoke('terminal:agent-switch-state', root)).canSwitch, false, 'draft is never lost on switch')
    emit('terminal:input', root, '\x15')
    assert.equal((await invoke('terminal:agent-switch-state', root)).canSwitch, true, 'Ctrl+U clears an end-of-line draft')
    emit('terminal:input', root, '未送信テスト')
    emit('terminal:input', root, '\x7f'.repeat(6))
    assert.equal((await invoke('terminal:agent-switch-state', root)).canSwitch, true, 'batched backspaces remove characters')
    emit('terminal:input', root, '\x1b[A')
    emit('terminal:input', root, '\x15')
    assert.equal((await invoke('terminal:agent-switch-state', root)).canSwitch, false, 'unknown history/cursor edits cannot bypass draft protection')
    emit('terminal:input', root, '\x03')
    assert.equal((await invoke('terminal:agent-switch-state', root)).canSwitch, true)
    stallNextSend = true
    const failedReturn = await invoke('terminal:switch-agent', root, 'codex')
    clockOffset = 0
    assert.equal(failedReturn.errorCode, 'timeout')
    const recovery = await invoke('terminal:agent-switch-recovery', root)
    assert.equal(recovery.agent, 'codex')
    assert.match(recovery.output, /Workspace trust/)
    assert.equal(ptys[1].killed, false)
    assert.equal(await invoke('terminal:agent-switch-recovery-input', 'wrong-tab', 'x'), false)
    assert.equal(await invoke('terminal:agent-switch-recovery-input', root, 'complete-setup\r'), true)
    await new Promise(resolve => setTimeout(resolve, 15))
    await invoke('terminal:agent-switch-recovery-input', root, 'unsent setup draft')
    assert.equal((await invoke('terminal:switch-agent', root, 'codex')).errorCode, 'setup_not_ready', 'recovery draft cannot be overwritten by retry')
    await invoke('terminal:agent-switch-recovery-input', root, '\x15')
    // xterm control replies must not invalidate an already-completed turn.
    await invoke('terminal:agent-switch-recovery-input', root, '\x1b[0n')
    const retry = invoke('terminal:switch-agent', root, 'codex')
    assert.equal(await invoke('terminal:agent-switch-recovery-input', root, 'must not reach pending target'), false)
    assert.equal((await retry).ok, true)
    assert.equal(ptys.length, 2, 'retry reuses target rather than duplicating it')
    assert.equal(await invoke('terminal:agent-switch-recovery', root), null)
    // A new CLI can sit idle beyond the startup watcher's 60s window. Its
    // first actual user prompt must re-arm transcript discovery before write.
    const delayed = await invoke('terminal:create', project)
    emit('terminal:input', delayed, 'claude\r')
    for (const timer of intervals.values()) if (timer.ms === 1500) timer.fn()
    for (const timer of longTimeouts) if (timer.ms === 60000) timer.fn()
    const idleWatchers = [...intervals.values()].filter(timer => timer.ms === 1000).length
    emit('terminal:input', delayed, 'delayed first prompt\r')
    assert.equal([...intervals.values()].filter(timer => timer.ms === 1000).length, idleWatchers + 1)
    emit('terminal:close', delayed)
    emit('terminal:close', root)
    assert.equal(ptys.every(p => p.killed), true)
  } finally {
    for (const timer of timeouts) clearTimeout(timer)
    fs.rmSync(testHome, { recursive: true, force: true })
  }
})
