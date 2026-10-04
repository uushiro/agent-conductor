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
  const handlers = new Map(), events = new Map(), intervals = new Map(), sent = [], ptys = [], timeouts = new Set()
  const sourceId = randomUUID()
  const sourcePath = path.join(testHome, '.claude/projects', project.replaceAll('/', '-'), sourceId + '.jsonl')
  const stamp = () => new Date().toISOString()
  const append = (file, records) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, records.map(JSON.stringify).join('\n') + '\n') }
  append(sourcePath, [
    { type: 'user', sessionId: sourceId, cwd: project, timestamp: stamp(), message: { role: 'user', content: 'Keep the approved scope; do not delete files.' } },
    { type: 'assistant', sessionId: sourceId, cwd: project, timestamp: stamp(), message: { role: 'assistant', content: [{ type: 'text', text: 'First phase done.' }], stop_reason: 'end_turn' } },
  ])
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
          if (data.startsWith('claude ')) this.process = 'claude'
          if (data.includes('\x1b[200~')) {
            const marker = data.match(/AC_HANDOFF_READY:([a-z0-9-]+)/)?.[0]
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
        setTimeout(() => {
          append(rollout, [
            { type: 'session_meta', timestamp: stamp(), payload: { id, cwd: project, source: 'cli', originator: 'codex_cli_rs' } },
            { type: 'response_item', timestamp: stamp(), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } },
            { type: 'response_item', timestamp: stamp(), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: prompt.match(/AC_HANDOFF_READY:[a-z0-9-]+/)[0] }] } },
            { type: 'event_msg', timestamp: stamp(), payload: { type: 'task_complete' } },
          ])
          proc.data?.('Codex ready\r\n')
        }, 5)
      }
      return proc
    },
  }
  const fakeRequire = name => {
    if (name === 'electron') return fakeElectron
    if (name === 'node-pty') return fakePty
    if (name === 'node:os') return { ...os, homedir: () => testHome }
    if (name === 'node:https') return { get() { throw new Error('Network forbidden in test') } }
    return require(name)
  }
  const context = {
    require: fakeRequire, exports: {}, module: { exports: {} }, __dirname: path.join(testHome, 'bundle'),
    process: { env: { SHELL: '/bin/zsh' }, platform: process.platform }, Buffer, console,
    setInterval(fn, ms) { const key = {}; intervals.set(key, { fn, ms }); return key },
    clearInterval(key) { intervals.delete(key) },
    setTimeout(fn, ms) { if (ms >= 1000) return {}; const handle = setTimeout(fn, 2); timeouts.add(handle); return handle },
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
    const watchdog = setTimeout(() => invoke('terminal:cancel-agent-switch', root), 2500)
    const switched = await invoke('terminal:switch-agent', root, 'codex')
    clearTimeout(watchdog)
    assert.equal(switched.ok, true, switched.error)
    assert.equal((await invoke('terminal:agent-switch-state', root)).agent, 'codex')
    assert.equal((await invoke('terminal:list-info')).length, 1)
    assert.equal((await invoke('terminal:list-info'))[0].id, root)
    assert.equal(sent.filter(e => e[0] === 'terminal:reset')[0][1], root)
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
    emit('terminal:close', root)
    assert.equal(ptys.every(p => p.killed), true)
  } finally {
    for (const timer of timeouts) clearTimeout(timer)
    fs.rmSync(testHome, { recursive: true, force: true })
  }
})
