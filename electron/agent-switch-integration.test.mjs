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
  const handlers = new Map(), events = new Map(), appEvents = new Map(), intervals = new Map(), sent = [], ptys = [], timeouts = new Set(), longTimeouts = []
  const sourceId = randomUUID()
  const sourcePath = path.join(testHome, '.claude/projects', project.replaceAll('/', '-'), sourceId + '.jsonl')
  const notePath = path.join(testHome, 'Desktop/works/ObsidianVault/LLM_talk/source-note.md')
  fs.mkdirSync(path.dirname(notePath), { recursive: true })
  fs.writeFileSync(notePath, `---\nsession_id: ${sourceId}\n---\nSaved decision: preserve the agreed migration deadline.`)
  const restoreId = randomUUID()
  const restorePath = path.join(testHome, '.claude/projects', project.replaceAll('/', '-'), restoreId + '.jsonl')
  const cleanPrompt = data => data.replace(/\x1b\[20[01]~/g, '').replace(/\r$/, '')
  const stamp = () => new Date().toISOString()
  const append = (file, records) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, records.map(JSON.stringify).join('\n') + '\n') }
  append(sourcePath, [
    { uuid: randomUUID(), type: 'user', sessionId: sourceId, cwd: project, timestamp: stamp(), message: { role: 'user', content: 'Keep the approved scope; do not delete files.' } },
    { uuid: randomUUID(), type: 'assistant', sessionId: sourceId, cwd: project, timestamp: stamp(), message: { role: 'assistant', content: [{ type: 'text', text: 'First phase done.' }], stop_reason: 'end_turn' } },
  ])
  append(restorePath, [
    { uuid: randomUUID(), type: 'user', sessionId: restoreId, cwd: project, timestamp: stamp(), message: { role: 'user', content: 'Restored authored instruction.' } },
    { uuid: randomUUID(), type: 'assistant', sessionId: restoreId, cwd: project, timestamp: stamp(), message: { role: 'assistant', content: [{ type: 'text', text: 'Ready before restart.' }], stop_reason: 'end_turn' } },
  ])
  let missingCli = false, stallNextSend = false, clockOffset = 0
  class TestDate extends Date { static now() { return Date.now() + clockOffset } }
  let ready
  const appReady = new Promise(resolve => { ready = resolve })
  const fakeElectron = {
    app: { getPath: () => testHome, setPath() {}, whenReady: () => ({ then(fn) { fn(); ready() } }), on: (name, fn) => appEvents.set(name, fn), getVersion: () => '0.0.0' },
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
      const proc = { process: options.env.AC_HANDOFF_PROMPT ? 'codex' : 'zsh', writes: [], killed: false, launchPrompt: options.env.AC_HANDOFF_PROMPT,
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
                append(this.rollout, [{ type: 'response_item', timestamp: stamp(), payload: { id: randomUUID(), type: 'message', role: 'user', content: [{ type: 'input_text', text: cleanPrompt(data) }] } }])
                setTimeout(() => { clockOffset = 61000; this.data?.('Workspace trust confirmation required\r\n') }, 5)
              } else setTimeout(() => this.complete(data), 5)
            }
            if (marker && this === ptys[0]) {
              setTimeout(() => append(sourcePath, [
                { uuid: randomUUID(), type: 'user', timestamp: stamp(), message: { role: 'user', content: cleanPrompt(data) } },
                { uuid: randomUUID(), type: 'assistant', timestamp: stamp(), message: { role: 'assistant', content: [{ type: 'text', text: marker }], stop_reason: 'end_turn' } },
              ]), 5)
            }
          }
        },
      }
      ptys.push(proc)
      if (options.env.AC_HANDOFF_PROMPT) {
        const resumingClaude = /exec claude --resume/.test(args[1])
        assert.match(args[1], resumingClaude ? /exec claude --resume [0-9a-f-]+ "\$ac_prompt"/ : /exec codex(?: resume [0-9a-f-]+)? "\$ac_prompt"/)
        if (resumingClaude) {
          const prompt = options.env.AC_HANDOFF_PROMPT
          setTimeout(() => {
            const marker = prompt.match(/AC_HANDOFF_READY:[a-z0-9-]+/)[0]
            append(args[1].includes(restoreId) ? restorePath : sourcePath, [
              { uuid: randomUUID(), type: 'user', timestamp: stamp(), message: { role: 'user', content: prompt } },
              { uuid: randomUUID(), type: 'assistant', timestamp: stamp(), message: { role: 'assistant', content: [{ type: 'text', text: marker }], stop_reason: 'end_turn' } },
            ])
            proc.data?.('Claude restored\r\n')
          }, 5)
          return proc
        }
        const id = randomUUID(), date = new Date()
        const rollout = path.join(testHome, '.codex/sessions', String(date.getFullYear()), String(date.getMonth()+1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'), `rollout-test-${id}.jsonl`)
        const prompt = options.env.AC_HANDOFF_PROMPT
        proc.rollout = rollout
        proc.complete = (receivedPrompt) => {
          append(rollout, [
            { type: 'session_meta', timestamp: stamp(), payload: { id, cwd: project, source: 'cli', originator: 'codex_cli_rs' } },
            { type: 'response_item', timestamp: stamp(), payload: { id: randomUUID(), type: 'message', role: 'user', content: [{ type: 'input_text', text: cleanPrompt(receivedPrompt) }] } },
            { type: 'response_item', timestamp: stamp(), payload: { id: randomUUID(), type: 'message', role: 'assistant', content: [{ type: 'output_text', text: receivedPrompt.match(/AC_HANDOFF_READY:[a-z0-9-]+/)[0] }] } },
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
    assert.match(ptys[1].launchPrompt, /Saved decision: preserve the agreed migration deadline/)
    assert.ok(ptys[1].launchPrompt.includes(notePath))
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
    assert.equal(saved.tabs[0].handoff.active.agent, 'codex')
    assert.equal(saved.tabs[0].handoff.parked[0].agent, 'claude')
    assert.equal(saved.tabs[0].handoff.parked[0].sessionId, sourceId)
    await invoke('terminal:set-issue', root, 'Renamed task')
    const returnWatchdog = setTimeout(() => invoke('terminal:cancel-agent-switch', root), 2500)
    const returned = await invoke('terminal:switch-agent', root, 'claude')
    clearTimeout(returnWatchdog)
    assert.equal(returned.ok, true, returned.error)
    assert.equal((await invoke('terminal:get-title', root)).issue, 'Renamed task')
    assert.equal(ptys.length, 2, 'return reuses source runtime')
    const handoffWrite = ptys[0].writes.find(value => value.includes('AC_HANDOFF_READY:'))
    assert.ok(handoffWrite.indexOf('AC_HANDOFF_READY:') < handoffWrite.indexOf('\x1b[200~'), 'receipt request is typed outside untrusted paste')
    assert.equal(ptys[0].killed, false)
    const preview = await invoke('terminal:agent-switch-context', root)
    assert.match(preview.text, /Keep the approved scope/)
    assert.match(preview.text, /First phase done/)
    assert.match(preview.text, /Saved decision: preserve the agreed migration deadline/)
    assert.match(handoffWrite, /Saved decision: preserve the agreed migration deadline/)
    assert.doesNotMatch(JSON.stringify(JSON.parse(fs.readFileSync(path.join(testHome, 'session.json'), 'utf8')).tabs[0].handoff.context), /Saved decision: preserve/)
    assert.doesNotMatch(preview.text, /AC_HANDOFF_READY|BEGIN.*HANDOFF/)
    assert.equal(preview.stats.turnCount, 2)
    assert.ok(preview.stats.omittedReceipts >= 4)
    const before = ptys[0].writes.length
    emit('terminal:input', root, '/tmp/stale-attachment.png', true)
    emit('terminal:input', root, '\r', true)
    assert.equal(ptys[0].writes.length, before, 'legacy delayed writes expire even after returning to original agent')
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
    const committedBeforeFailure = JSON.parse(fs.readFileSync(path.join(testHome, 'session.json'), 'utf8')).tabs[0].handoff
    stallNextSend = true
    const failedReturn = await invoke('terminal:switch-agent', root, 'codex')
    clockOffset = 0
    assert.equal(failedReturn.errorCode, 'timeout')
    const recovery = await invoke('terminal:agent-switch-recovery', root)
    assert.equal(recovery.agent, 'codex')
    assert.match(recovery.output, /Workspace trust/)
    assert.equal(ptys[1].killed, false)
    const quitEvent = { preventDefault() {} }
    appEvents.get('before-quit')(quitEvent); appEvents.get('before-quit')(quitEvent)
    const savedDuringRecovery = JSON.parse(fs.readFileSync(path.join(testHome, 'session.json'), 'utf8')).tabs[0].handoff
    assert.equal(JSON.stringify({ active: savedDuringRecovery.active, parked: savedDuringRecovery.parked }), JSON.stringify({ active: committedBeforeFailure.active, parked: committedBeforeFailure.parked }), 'failed recovery preserves the committed exact sessions and does not persist a new runtime')
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
    const codexHandoffWrite = ptys[1].writes.find(value => value.includes('AC_HANDOFF_READY:'))
    assert.ok(codexHandoffWrite.startsWith('\x1b[200~'), 'Codex receives its instruction inside the full paste')
    assert.equal(await invoke('terminal:agent-switch-recovery', root), null)
    const destination = await invoke('terminal:handoff-draft-destination', root)
    const draft = await invoke('terminal:set-handoff-draft', root, 'draft remains until destination is verified')
    const writesBeforeDraft = ptys[1].writes.length
    const rejectedDraft = await invoke('terminal:submit-handoff-draft', root, draft.revision, 'stale-destination')
    assert.equal(rejectedDraft.ok, false)
    assert.equal((await invoke('terminal:handoff-draft', root)).text, 'draft remains until destination is verified')
    const submittedDraft = await invoke('terminal:submit-handoff-draft', root, draft.revision, destination.token)
    assert.equal(submittedDraft.ok, true)
    assert.equal(ptys[1].writes.length, writesBeforeDraft + 1)
    assert.equal((await invoke('terminal:submit-handoff-draft', root, draft.revision, destination.token)).ok, false, 'duplicate revision cannot send twice')
    const restoredTab = await invoke('terminal:create', project)
    const blankRestorePty = ptys.at(-1)
    await invoke('terminal:set-issue', restoredTab, 'Restored title')
    const restored = await invoke('terminal:restore-handoff-session', restoredTab, { active: { agent: 'claude', sessionId: restoreId, cwd: project }, parked: [], context: undefined, history: [] })
    assert.equal(restored.ok, true); assert.equal(restored.pending, true)
    assert.equal(blankRestorePty.killed, true, 'blank shell is replaced under the same public tab ID')
    assert.equal((await invoke('terminal:agent-switch-state', restoredTab)).canSwitch, false, 'old completed transcript is gated until fresh receipt')
    await new Promise(resolve => setTimeout(resolve, 15))
    assert.equal((await invoke('terminal:agent-switch-state', restoredTab)).canSwitch, true)
    assert.equal((await invoke('terminal:get-title', restoredTab)).issue, 'Restored title')
    emit('terminal:close', restoredTab)
    const blankMalformed = await invoke('terminal:create', project)
    const malformed = await invoke('terminal:restore-handoff-session', blankMalformed, { active: { agent: 'claude', sessionId: restoreId, cwd: project }, parked: [], context: { nope: true }, history: [] })
    assert.equal(malformed.errorCode, 'saved_context_unavailable', 'malformed context is rejected before launching a resume')
    const blankMissing = await invoke('terminal:create', project)
    const missingRestore = await invoke('terminal:restore-handoff-session', blankMissing, { active: { agent: 'claude', sessionId: randomUUID(), cwd: project }, parked: [], context: undefined, history: [] })
    assert.equal(missingRestore.errorCode, 'saved_session_unavailable')
    const blankMismatch = await invoke('terminal:create', project)
    const mismatchRestore = await invoke('terminal:restore-handoff-session', blankMismatch, { active: { agent: 'claude', sessionId: restoreId, cwd: path.join(project, 'wrong-cwd') }, parked: [], context: undefined, history: [] })
    assert.equal(mismatchRestore.errorCode, 'saved_session_unavailable')
    emit('terminal:close', blankMalformed); emit('terminal:close', blankMissing); emit('terminal:close', blankMismatch)
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
