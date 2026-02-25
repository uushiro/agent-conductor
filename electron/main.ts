import { app, BrowserWindow, ipcMain, shell, clipboard } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { execFile } from 'node:child_process'

// node-pty is a native module — require it
const pty = require('node-pty')

let mainWindow: BrowserWindow | null = null
let ipcHandlersRegistered = false
let quitConfirmPending = false
let quitConfirmTimer: ReturnType<typeof setTimeout> | null = null

const SHELLS = new Set(['zsh', 'bash', 'fish', 'sh', 'login'])

// Map of tabId → pty instance
const ptyProcesses = new Map<string, ReturnType<typeof pty.spawn>>()
const tabTimers = new Map<string, ReturnType<typeof setInterval>>()
const tabInfo = new Map<string, {
  cwd: string; proc: string; issue: string; latestInput: string
  claudeSessionId: string | null; claudeResumeParentId: string | null; hadClaude: boolean
  hadGemini: boolean; geminiSessionFile: string | null
}>()

interface ClosedTabEntry {
  issue: string
  cwd: string
  claudeSessionId: string | null
  agent: 'claude' | 'gemini'
  closedAt: number
}
const closedTabsHistory: ClosedTabEntry[] = []
const tabInputBuf = new Map<string, string>()
const tabLastOutput = new Map<string, string>()
const tabLastOutputAt = new Map<string, number>()
const tabLastInputAt = new Map<string, number>()
const tabSessionWatchers = new Map<string, ReturnType<typeof setInterval>>()
const tabGeminiSessionWatchers = new Map<string, ReturnType<typeof setInterval>>()
// tabId → timestamp until which [[TASK:]] detection is suppressed (resume replay window)
const tabTaskCooldown = new Map<string, number>()
const TASK_RESUME_COOLDOWN_MS = 60000
// tabId → unscanned tail buffer for [[TASK:]] detection (consumed on match to prevent re-detection)
const tabTaskScanBuf = new Map<string, string>()
// Deduplicate task emissions within a session (cleared on session:load)
const emittedTaskTitles = new Set<string>()

// Strip ANSI/OSC escape codes and extract last meaningful line
function extractLastLine(raw: string): string {
  const stripped = raw
    .replace(/\x1b\][^\x07\x1b]*\x07/g, '')          // OSC sequences (e.g. ]0;title BEL)
    .replace(/\x1b\][^\x1b]*\x1b\\/g, '')             // OSC sequences (ST terminated)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')           // CSI sequences
    .replace(/\x1b[a-zA-Z]/g, '')                     // simple escape sequences
    .replace(/\r/g, '')

  const lines = stripped.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !/^\?.*shortcut/i.test(l))         // filter "? for shortcuts"
    .filter((l) => !/^[>›❯%$]\s*$/.test(l))           // filter bare prompts
    .filter((l) => !/^yuushirokawa@/.test(l))         // filter shell prompt lines

  return lines[lines.length - 1] || ''
}
// Ordered list of tab IDs to preserve tab order
const tabOrder: string[] = []
let tabCounter = 0
const HOME = process.env.HOME || os.homedir()

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

// --- Session persistence ---
interface SavedTab {
  issue: string
  cwd: string
  hadClaude: boolean
  claudeSessionId: string | null
  hadGemini: boolean
}

interface SavedSession {
  tabs: SavedTab[]
  activeIndex: number
}

const SESSION_FILE = path.join(app.getPath('userData'), 'session.json')

// Get recent Claude session IDs for a cwd, sorted by most recent first
function getRecentClaudeSessions(cwd: string): string[] {
  const encoded = cwd.replace(/\//g, '-')
  const sessionDir = path.join(HOME, '.claude', 'projects', encoded)
  try {
    return fs.readdirSync(sessionDir)
      .filter((f: string) => f.endsWith('.jsonl'))
      .map((f: string) => ({
        id: f.replace('.jsonl', ''),
        mtime: fs.statSync(path.join(sessionDir, f)).mtime.getTime(),
      }))
      .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime)
      .map((f: { id: string }) => f.id)
  } catch { /* ignore */ }
  return []
}

function saveSession() {
  const tabs: SavedTab[] = []
  for (const id of tabOrder) {
    const info = tabInfo.get(id)
    if (info) {
      const hadClaude = info.hadClaude
      let claudeSessionId: string | null = null

      if (hadClaude) {
        if (info.claudeResumeParentId) {
          // This session was started via --resume. The parent ID is the safe, resumable
          // checkpoint. Continuation files created by claude --resume are not themselves
          // directly resumable (claude returns "No conversation found").
          if (sessionHasConversation(info.claudeResumeParentId, info.cwd || HOME)) {
            claudeSessionId = info.claudeResumeParentId
          } else if (info.claudeSessionId && sessionHasConversation(info.claudeSessionId, info.cwd || HOME)) {
            // Parent missing/empty (edge case) → fall back to continuation
            claudeSessionId = info.claudeSessionId
          }
        } else {
          // Fresh session (not started via --resume): save the watcher-detected ID
          if (info.claudeSessionId && sessionHasConversation(info.claudeSessionId, info.cwd || HOME)) {
            claudeSessionId = info.claudeSessionId
          }
        }
        // If neither has conversation content, claudeSessionId stays null → next launch
        // starts a fresh Claude session (correct behaviour for tabs with no history).
      }

      tabs.push({
        issue: info.issue,
        cwd: info.cwd || HOME,
        hadClaude,
        claudeSessionId,
        hadGemini: info.hadGemini,
      })
    }
  }
  const session: SavedSession = { tabs: tabs.slice(0, 15), activeIndex: 0 }
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session), 'utf-8')
  } catch { /* ignore */ }
}

function loadSession(): SavedSession | null {
  try {
    const raw = fs.readFileSync(SESSION_FILE, 'utf-8')
    const session = JSON.parse(raw) as SavedSession
    if (session.tabs && session.tabs.length > 0) return session
  } catch { /* ignore */ }
  return null
}

// --- Title logic ---

function shortDir(cwd: string): string {
  const shortCwd = cwd.startsWith(HOME) ? '~' + cwd.slice(HOME.length) : cwd
  return shortCwd.split('/').pop() || shortCwd || '~'
}

function getTabTitle(info: { proc: string; cwd: string; issue: string; latestInput: string }): { issue: string; detail: string } {
  const dirName = shortDir(info.cwd)

  if (info.issue) {
    return { issue: info.issue, detail: info.latestInput || dirName }
  }

  if (!info.proc || SHELLS.has(info.proc)) {
    return { issue: '', detail: dirName }
  }

  return { issue: '', detail: `${info.proc} — ${dirName}` }
}

// Watch for the new JSONL file that Claude creates on startup.
// Uses mtime-based detection: only considers files created after this watcher started.
// The 3000ms stagger between tab restores (see TerminalTabs.tsx) ensures each tab's
// file is in knownFiles before the next tab's watcher takes its snapshot.
function startSessionWatch(tabId: string, cwd: string) {
  const existing = tabSessionWatchers.get(tabId)
  if (existing) { clearInterval(existing); tabSessionWatchers.delete(tabId) }

  const encoded = cwd.replace(/\//g, '-')
  const sessionDir = path.join(HOME, '.claude', 'projects', encoded)

  // Snapshot of files that exist BEFORE Claude starts
  let knownFiles: Set<string>
  try {
    knownFiles = new Set(fs.readdirSync(sessionDir).filter((f: string) => f.endsWith('.jsonl')))
  } catch {
    knownFiles = new Set()
  }
  const startTime = Date.now()

  const watcher = setInterval(() => {
    try {
      const current = fs.readdirSync(sessionDir).filter((f: string) => f.endsWith('.jsonl'))
      const newFiles = current
        .filter((f: string) => !knownFiles.has(f))
        .map((f: string) => {
          try {
            const mtime = fs.statSync(path.join(sessionDir, f)).mtimeMs
            return { file: f, mtime }
          } catch { return null }
        })
        .filter((entry): entry is { file: string; mtime: number } => entry !== null && entry.mtime >= startTime)
        .sort((a, b) => a.mtime - b.mtime)

      if (newFiles.length > 0) {
        const sessionId = newFiles[0].file.replace('.jsonl', '')
        const info = tabInfo.get(tabId)
        if (info) { info.claudeSessionId = sessionId; tabInfo.set(tabId, info) }
        clearInterval(watcher)
        tabSessionWatchers.delete(tabId)
      }
    } catch { /* ignore */ }
  }, 1000)

  tabSessionWatchers.set(tabId, watcher)
  setTimeout(() => {
    const w = tabSessionWatchers.get(tabId)
    if (w === watcher) { clearInterval(watcher); tabSessionWatchers.delete(tabId) }
  }, 60000)
}

// --- Gemini session helpers ---

// Gemini stores sessions in ~/.gemini/tmp/<project-dirname>/chats/session-*.json
function geminiSessionDir(cwd: string): string {
  return path.join(HOME, '.gemini', 'tmp', path.basename(cwd) || 'home', 'chats')
}

// Get the most recently modified Gemini session file for a cwd
function getLastGeminiSessionFile(cwd: string): string | null {
  const dir = geminiSessionDir(cwd)
  try {
    const files = fs.readdirSync(dir)
      .filter((f: string) => f.startsWith('session-') && f.endsWith('.json'))
      .map((f: string) => ({ file: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime)
    if (files.length > 0) return path.join(dir, (files[0] as { file: string }).file)
  } catch { /* ignore */ }
  return null
}

// Read the last Gemini response text from a session JSON file
function getLastGeminiSessionText(sessionFile: string | null): string {
  if (!sessionFile) return ''
  try {
    const raw = fs.readFileSync(sessionFile, 'utf-8')
    const session = JSON.parse(raw)
    const messages: Array<{ type: string; content: unknown }> = session.messages || []
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.type === 'gemini' && typeof msg.content === 'string' && msg.content.trim()) {
        return msg.content.slice(0, 120).replace(/\n+/g, ' ').trim()
      }
    }
  } catch { /* ignore */ }
  return ''
}

// Watch for a new Gemini session file created after Gemini starts
function startGeminiSessionWatch(tabId: string, cwd: string) {
  const existing = tabGeminiSessionWatchers.get(tabId)
  if (existing) { clearInterval(existing); tabGeminiSessionWatchers.delete(tabId) }

  const sessionDir = geminiSessionDir(cwd)
  let knownFiles: Set<string>
  try {
    knownFiles = new Set(fs.readdirSync(sessionDir).filter((f: string) => f.startsWith('session-') && f.endsWith('.json')))
  } catch { knownFiles = new Set() }
  const startTime = Date.now()

  const watcher = setInterval(() => {
    try {
      const current = fs.readdirSync(sessionDir).filter((f: string) => f.startsWith('session-') && f.endsWith('.json'))
      const newFiles = current
        .filter((f: string) => !knownFiles.has(f))
        .map((f: string) => {
          try { return { file: f, mtime: fs.statSync(path.join(sessionDir, f)).mtimeMs } }
          catch { return null }
        })
        .filter((e): e is { file: string; mtime: number } => e !== null && e.mtime >= startTime - 500)
        .sort((a, b) => a.mtime - b.mtime)
      if (newFiles.length > 0) {
        const sessionFile = path.join(sessionDir, newFiles[0].file)
        const info = tabInfo.get(tabId)
        if (info) { info.geminiSessionFile = sessionFile; tabInfo.set(tabId, info) }
        clearInterval(watcher)
        tabGeminiSessionWatchers.delete(tabId)
      }
    } catch { /* ignore */ }
  }, 1000)

  tabGeminiSessionWatchers.set(tabId, watcher)
  setTimeout(() => {
    const w = tabGeminiSessionWatchers.get(tabId)
    if (w === watcher) { clearInterval(watcher); tabGeminiSessionWatchers.delete(tabId) }
  }, 60000)
}

// Check if a session file has actual conversation content
function sessionHasConversation(sessionId: string, cwd: string): boolean {
  const encoded = cwd.replace(/\//g, '-')
  const filePath = path.join(HOME, '.claude', 'projects', encoded, `${sessionId}.jsonl`)
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    return /"type":"(user|assistant)"/.test(content)
  } catch { return false }
}

// Read the last assistant response text from a session JSONL file (skips thinking blocks).
// Reads only the last 5000 bytes for efficiency on large files.
function getLastSessionText(sessionId: string | null, cwd: string): string {
  if (!sessionId) return ''
  try {
    const encoded = cwd.replace(/\//g, '-')
    const filePath = path.join(HOME, '.claude', 'projects', encoded, `${sessionId}.jsonl`)
    const stat = fs.statSync(filePath)
    const readSize = Math.min(5000, stat.size)
    const buf = Buffer.alloc(readSize)
    const fd = fs.openSync(filePath, 'r')
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize)
    fs.closeSync(fd)
    const lines = buf.toString('utf-8').split('\n').filter(l => l.trim())
    // Iterate from last to first to find the most recent assistant text
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i])
        if (entry.type === 'assistant') {
          const content = entry.message?.content
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text?.trim()) {
                return block.text.slice(0, 120).replace(/\n+/g, ' ').trim()
              }
            }
          }
        }
      } catch { /* incomplete JSON at start of read window, skip */ }
    }
  } catch { /* file not found or other error */ }
  return ''
}

// Extract the current Claude action from PTY buffer.
// Scans backward for tool calls (Bash, Read, Write, ...) or thinking indicators.
// Falls back to 'Thinking...' if nothing useful is found.
function extractClaudeAction(raw: string): string {
  const stripped = raw
    .replace(/\x1b\][^\x07\x1b]*\x07/g, '')
    .replace(/\x1b\][^\x1b]*\x1b\\/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b[a-zA-Z]/g, '')
    .replace(/\r/g, '')

  const lines = stripped.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !/^esc to interrupt/i.test(l))
    .filter((l) => !/^\?.*shortcut/i.test(l))
    .filter((l) => !/^ctrl\+/i.test(l))
    .filter((l) => !/^[>›❯%$]\s*$/.test(l))
    .filter((l) => !/^yuushirokawa@/.test(l))
    .filter((l) => !/^\*?Worked for /i.test(l))

  const TOOLS = [
    'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep',
    'WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'TodoWrite', 'TodoRead', 'LS',
  ]
  // Match tool name anywhere in the line (Claude prefixes with ● or spinner chars)
  const toolRegex = new RegExp(`(${TOOLS.join('|')}|mcp__[\\w]+)\\s*[\\[(]`)

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]

    // Tool call: ToolName(args...) or ToolName[args...]
    const toolMatch = line.match(toolRegex)
    if (toolMatch) {
      const toolName = toolMatch[1]
      const delimIdx = Math.min(
        line.indexOf('(') >= 0 ? line.indexOf('(') : Infinity,
        line.indexOf('[') >= 0 ? line.indexOf('[') : Infinity,
      )
      const arg = line.slice(delimIdx + 1, delimIdx + 60).replace(/[)\]…]+$/, '').trim()
      return arg ? `${toolName}: ${arg}` : toolName
    }

    // Gemini tool format: ServerName[method](args) e.g. "Claude in Chrome[navigate](url)"
    const geminiToolMatch = line.match(/^[●•⠿⠸⠼⠦⠧⠇⠏\s]*(.+?)\[(\w+)\](?:\(([^)]*)\))?$/)
    if (geminiToolMatch && geminiToolMatch[1].trim().length > 0 && geminiToolMatch[1].trim().length < 50) {
      const server = geminiToolMatch[1].trim()
      const method = geminiToolMatch[2]
      const arg = geminiToolMatch[3] ? `: ${geminiToolMatch[3].slice(0, 40)}` : ''
      return `${server}[${method}]${arg}`
    }

    // Thinking/processing animations (Claude and Gemini variants)
    if (/Kneading|Thinking|Levitating|Brewing|Brewed|Cooked|Baking|Distilling/i.test(line)) {
      return 'Thinking...'
    }

    // File reading progress
    const readingMatch = line.match(/Reading (\d+ files?)/i)
    if (readingMatch) return `Reading ${readingMatch[1]}`
  }

  return 'Thinking...'
}

function updateTabInfo(id: string, ptyProcess: ReturnType<typeof pty.spawn>) {
  const info = tabInfo.get(id) || { cwd: '', proc: '', issue: '', latestInput: '', claudeSessionId: null as string | null, claudeResumeParentId: null as string | null, hadClaude: false }
  const prevProc = info.proc

  try {
    info.proc = ptyProcess.process || ''
  } catch { /* ignore */ }

  // When process changes (shell↔app), clear output buffer
  if (prevProc !== info.proc) {
    tabLastOutput.delete(id)
    tabLastOutputAt.delete(id)
    if (SHELLS.has(prevProc) && !SHELLS.has(info.proc) && info.proc !== '') {
      // Shell → agent: mark appropriate flag (session watch started at input time)
      if (info.proc === 'claude') info.hadClaude = true
      if (info.proc === 'gemini') info.hadGemini = true
    } else if (prevProc !== '' && !SHELLS.has(prevProc) && SHELLS.has(info.proc)) {
      // Agent → shell: clear agent state
      if (prevProc === 'claude') {
        info.hadClaude = false
        info.claudeSessionId = null
        info.claudeResumeParentId = null
      }
      if (prevProc === 'gemini') {
        info.hadGemini = false
        info.geminiSessionFile = null
      }
      info.latestInput = ''
      tabInputBuf.delete(id)
    }
  }

  execFile('lsof', ['-a', '-p', String(ptyProcess.pid), '-d', 'cwd', '-Fn'], (err, stdout) => {
    if (!err) {
      const match = stdout.match(/^n(.+)$/m)
      if (match) info.cwd = match[1]
    }
    tabInfo.set(id, info)
  })
}

function spawnPty(cwd?: string): { id: string; ptyProcess: ReturnType<typeof pty.spawn> } {
  const id = `tab-${++tabCounter}`
  const shell = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : 'zsh')
  const initialCwd = cwd || HOME
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: initialCwd,
    env: (() => {
      const env = { ...process.env } as Record<string, string>
      delete env.CLAUDECODE
      return env
    })(),
  })

  ptyProcesses.set(id, ptyProcess)
  tabInfo.set(id, { cwd: initialCwd, proc: '', issue: '', latestInput: '', claudeSessionId: null, claudeResumeParentId: null, hadClaude: false, hadGemini: false, geminiSessionFile: null })
  tabOrder.push(id)

  // Relay pty output → renderer, and buffer last output for sidebar
  ptyProcess.onData((data: string) => {
    mainWindow?.webContents.send('terminal:data', id, data)
    const prev = tabLastOutput.get(id) || ''
    const combined = (prev + data).slice(-3000)
    tabLastOutput.set(id, combined)
    tabLastOutputAt.set(id, Date.now())

    // Detect [[TASK: ...]] pattern — skip during resume replay cooldown
    const cooldownEnd = tabTaskCooldown.get(id) ?? 0
    if (Date.now() > cooldownEnd) {
      const overlap = tabTaskScanBuf.get(id) || ''
      const scanBuf = overlap + data
      const stripped = scanBuf.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '')
      let lastMatchEnd = 0
      for (const match of stripped.matchAll(/\[\[TASK:\s*(.+?)\]\]/g)) {
        const title = match[1].trim()
        const normalized = title.toLowerCase()
        if (title && !emittedTaskTitles.has(normalized)) {
          emittedTaskTitles.add(normalized)
          mainWindow?.webContents.send('task:add', title)
        }
        lastMatchEnd = match.index! + match[0].length
      }
      // Detect [[TASK-SETALL: ...json...]] pattern — replaces entire task list
      for (const match of stripped.matchAll(/\[\[TASK-SETALL:\s*(.+?)\]\]/g)) {
        try {
          const tasksJson = match[1].trim()
          mainWindow?.webContents.send('task:set-all', tasksJson)
        } catch { /* ignore */ }
        lastMatchEnd = match.index! + match[0].length
      }
      // Keep only the unmatched tail for split-chunk detection (max 100 chars)
      tabTaskScanBuf.set(id, stripped.slice(Math.max(lastMatchEnd, stripped.length - 100)))
    }
  })

  // Poll process name + cwd
  const timer = setInterval(() => updateTabInfo(id, ptyProcess), 1500)
  tabTimers.set(id, timer)

  // Initial update
  setTimeout(() => updateTabInfo(id, ptyProcess), 500)

  return { id, ptyProcess }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: 'Agent Conductor',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Register IPC handlers only once (guard against createWindow being called multiple times)
  if (!ipcHandlersRegistered) {
    ipcHandlersRegistered = true

  // Create a new terminal tab (optional cwd)
  // pendingSessionId: if provided, pre-marks this tab as hadClaude=true with a resume fallback.
  // This ensures saveSession() can recover the session ID even if the app exits before Claude starts.
  ipcMain.handle('terminal:create', (_event, cwd?: string, pendingSessionId?: string) => {
    const { id } = spawnPty(cwd)
    if (pendingSessionId) {
      const info = tabInfo.get(id)!
      info.hadClaude = true
      info.claudeResumeParentId = pendingSessionId
      tabInfo.set(id, info)
    }
    return id
  })

  // Get title for a tab (poll from renderer)
  ipcMain.handle('terminal:get-title', (_event, tabId: string) => {
    const info = tabInfo.get(tabId)
    if (!info) return { issue: '', detail: 'Terminal' }
    const result = getTabTitle(info)
    // If detail fell back to directory name (latestInput is empty), try to populate
    // from session file so resumed tabs show last response instead of "~"
    if (result.detail === shortDir(info.cwd)) {
      if (info.hadClaude) {
        const cwd = info.cwd || HOME
        let sessionId = info.claudeSessionId
        if (!sessionId) sessionId = getRecentClaudeSessions(cwd)[0] || null
        let text = getLastSessionText(sessionId, cwd)
        if (!text && info.claudeResumeParentId && info.claudeResumeParentId !== sessionId) {
          text = getLastSessionText(info.claudeResumeParentId, cwd)
        }
        if (text) result.detail = text
      } else if (info.hadGemini) {
        const cwd = info.cwd || HOME
        const sessionFile = info.geminiSessionFile || getLastGeminiSessionFile(cwd)
        const text = getLastGeminiSessionText(sessionFile)
        if (text) result.detail = text
      }
    }
    return result
  })

  // Set issue from renderer (manual rename)
  ipcMain.handle('terminal:set-issue', (_event, tabId: string, issue: string) => {
    const info = tabInfo.get(tabId)
    if (info) {
      info.issue = issue
      tabInfo.set(tabId, info)
    }
  })

  // List all tab info (for sidebar), sorted by most recently user-input first
  ipcMain.handle('terminal:list-info', () => {
    const now = Date.now()
    return [...tabOrder]
      .map((id) => {
        const info = tabInfo.get(id)
        const lastOutputAt = tabLastOutputAt.get(id) ?? 0
        const lastInputAt = tabLastInputAt.get(id) ?? 0
        // "active" = PTY had output within the last 3 s (agent is generating)
        const active = (now - lastOutputAt) < 3000
        const isClaudeRunning = !!info?.hadClaude && !!info?.proc && !SHELLS.has(info.proc)
        const isGeminiRunning = !!info?.hadGemini && !!info?.proc && !SHELLS.has(info.proc)
        const isAgentRunning = isClaudeRunning || isGeminiRunning
        const isThinking = isAgentRunning && active

        let lastOutput: string
        if (isAgentRunning && active) {
          // Agent is actively generating — detect tool calls or show Thinking...
          lastOutput = extractClaudeAction(tabLastOutput.get(id) || '')
        } else if (isClaudeRunning) {
          // Claude idle — show last assistant text from JSONL
          const cwd = info!.cwd || HOME
          let sessionId = info!.claudeSessionId
          if (!sessionId) sessionId = getRecentClaudeSessions(cwd)[0] || null
          lastOutput = getLastSessionText(sessionId, cwd)
          // If current session is empty (e.g. just resumed, no new messages yet),
          // fall back to the parent session which has the prior conversation
          if (!lastOutput && info!.claudeResumeParentId && info!.claudeResumeParentId !== sessionId) {
            lastOutput = getLastSessionText(info!.claudeResumeParentId, cwd)
          }
        } else if (isGeminiRunning) {
          // Gemini idle — show last response from session JSON
          const cwd = info!.cwd || HOME
          let sessionFile = info!.geminiSessionFile
          if (!sessionFile) sessionFile = getLastGeminiSessionFile(cwd)
          lastOutput = getLastGeminiSessionText(sessionFile)
        } else {
          lastOutput = extractLastLine(tabLastOutput.get(id) || '')
        }

        if (!info) return { id, cwd: '', proc: '', issue: '', latestInput: '', claudeSessionId: null, lastOutput: '', active, lastInputAt, isThinking: false }
        return {
          id,
          cwd: info.cwd,
          proc: info.proc,
          issue: info.issue,
          latestInput: info.latestInput,
          claudeSessionId: info.claudeSessionId,
          lastOutput,
          active,
          lastInputAt,
          isThinking,
        }
      })
      .sort((a, b) => b.lastInputAt - a.lastInputAt)
  })

  // Load saved session — clears all existing PTY state first to prevent tab accumulation on HMR reloads
  ipcMain.handle('session:load', () => {
    // Kill and clear all existing terminals before restoring
    for (const timer of tabTimers.values()) clearInterval(timer)
    tabTimers.clear()
    for (const proc of ptyProcesses.values()) {
      try { proc.kill() } catch { /* ignore */ }
    }
    ptyProcesses.clear()
    tabInfo.clear()
    tabInputBuf.clear()
    tabLastOutput.clear()
    tabLastOutputAt.clear()
    tabLastInputAt.clear()
    tabTaskScanBuf.clear()
    tabTaskCooldown.clear()
    emittedTaskTitles.clear()
    for (const w of tabSessionWatchers.values()) clearInterval(w)
    tabSessionWatchers.clear()
    for (const w of tabGeminiSessionWatchers.values()) clearInterval(w)
    tabGeminiSessionWatchers.clear()
    tabOrder.length = 0
    tabCounter = 0
    closedTabsHistory.length = 0

    return loadSession()
  })

  // Close a terminal tab
  ipcMain.on('terminal:close', (_event: Electron.IpcMainEvent, tabId: string) => {
    // Save to closed history if had an agent session
    const closingInfo = tabInfo.get(tabId)
    if (closingInfo?.hadClaude) {
      const sessionId = closingInfo.claudeSessionId || closingInfo.claudeResumeParentId
      if (sessionId && sessionHasConversation(sessionId, closingInfo.cwd || HOME)) {
        closedTabsHistory.unshift({
          issue: closingInfo.issue, cwd: closingInfo.cwd || HOME,
          claudeSessionId: sessionId, agent: 'claude', closedAt: Date.now(),
        })
        if (closedTabsHistory.length > 10) closedTabsHistory.pop()
      }
    } else if (closingInfo?.hadGemini) {
      const sessionFile = closingInfo.geminiSessionFile || getLastGeminiSessionFile(closingInfo.cwd || HOME)
      if (sessionFile) {
        closedTabsHistory.unshift({
          issue: closingInfo.issue, cwd: closingInfo.cwd || HOME,
          claudeSessionId: null, agent: 'gemini', closedAt: Date.now(),
        })
        if (closedTabsHistory.length > 10) closedTabsHistory.pop()
      }
    }

    const timer = tabTimers.get(tabId)
    if (timer) { clearInterval(timer); tabTimers.delete(tabId) }
    tabInfo.delete(tabId)
    tabInputBuf.delete(tabId)
    tabLastOutput.delete(tabId)
    tabLastOutputAt.delete(tabId)
    tabLastInputAt.delete(tabId)
    tabTaskScanBuf.delete(tabId)
    const sw = tabSessionWatchers.get(tabId)
    if (sw) { clearInterval(sw); tabSessionWatchers.delete(tabId) }
    const idx = tabOrder.indexOf(tabId)
    if (idx !== -1) tabOrder.splice(idx, 1)
    const proc = ptyProcesses.get(tabId)
    if (proc) {
      proc.kill()
      ptyProcesses.delete(tabId)
    }
  })

  // Reorder tabs (drag & drop from renderer)
  ipcMain.on('terminal:reorder', (_event: Electron.IpcMainEvent, newOrder: string[]) => {
    tabOrder.length = 0
    for (const id of newOrder) {
      if (ptyProcesses.has(id)) tabOrder.push(id)
    }
  })

  // Whether a tab has an active claude session (used for close confirmation)
  ipcMain.handle('terminal:get-tab-has-claude', (_event, tabId: string) => {
    const info = tabInfo.get(tabId)
    return !!(info?.hadClaude || info?.hadGemini)
  })

  // Get recently closed tab history (for restore menu)
  ipcMain.handle('terminal:get-closed-history', () => {
    return [...closedTabsHistory]
  })

  // Remove an entry from closed history after restore
  ipcMain.on('terminal:remove-closed-history', (_event: Electron.IpcMainEvent, sessionId: string) => {
    const idx = closedTabsHistory.findIndex((e) => e.claudeSessionId === sessionId)
    if (idx !== -1) closedTabsHistory.splice(idx, 1)
  })

  // Relay renderer input → pty, and capture prompts / detect claude launch
  ipcMain.on('terminal:input', (_event: Electron.IpcMainEvent, tabId: string, data: string) => {
    const proc = ptyProcesses.get(tabId)
    if (proc) {
      proc.write(data)
    }

    const info = tabInfo.get(tabId)
    if (!info) return

    const isShell = !info.proc || SHELLS.has(info.proc)

    if (data === '\r' || (data.includes('\r') && data.length > 1)) {
      // Extract the command (handles both single '\r' and batch 'command\r')
      const buffered = tabInputBuf.get(tabId) || ''
      const batchCmd = data.includes('\r') && data.length > 1 ? data.split('\r')[0] : ''
      const input = (buffered + batchCmd).trim()
      tabInputBuf.set(tabId, '')

      if (isShell) {
        // Detect "gemini" command
        if (/^gemini(\s|$)/.test(input)) {
          info.hadGemini = true
          tabInfo.set(tabId, info)
          startGeminiSessionWatch(tabId, info.cwd || HOME)
          if (/--resume/.test(input)) {
            tabTaskCooldown.set(tabId, Date.now() + TASK_RESUME_COOLDOWN_MS)
          }
        }

        // Detect "claude" command being launched from shell → snapshot NOW before file is created
        if (/^claude(\s|$)/.test(input)) {
          info.hadClaude = true
          // If resuming a specific session, save the ID directly
          const resumeMatch = input.match(/--resume\s+([a-f0-9-]{36})/)
          if (resumeMatch) {
            // Save the parent session ID as fallback; watcher will update claudeSessionId
            // to the new continuation file Claude creates on --resume
            info.claudeSessionId = resumeMatch[1]
            info.claudeResumeParentId = resumeMatch[1]
            tabInfo.set(tabId, info)
            startSessionWatch(tabId, info.cwd || HOME)
            // Suppress [[TASK:]] detection during resume replay
            tabTaskCooldown.set(tabId, Date.now() + TASK_RESUME_COOLDOWN_MS)
          } else {
            info.claudeResumeParentId = null
            tabInfo.set(tabId, info)
            startSessionWatch(tabId, info.cwd || HOME)
          }
        }
      } else {
        // Non-shell: capture prompt as issue/latestInput
        if (input.length > 0) {
          const truncated = input.length > 50 ? input.slice(0, 50) + '…' : input
          if (!info.issue) info.issue = truncated
          info.latestInput = truncated
          tabInfo.set(tabId, info)
          // Record the time the user sent input (used for sidebar ordering)
          tabLastInputAt.set(tabId, Date.now())
          // Resume replay is over — user is now interacting, allow task detection
          tabTaskCooldown.delete(tabId)
        }
      }
    } else if (data === '\x7f' || data === '\b') {
      const buf = tabInputBuf.get(tabId) || ''
      tabInputBuf.set(tabId, buf.slice(0, -1))
    } else if (data === '\x03' || data === '\x04') {
      tabInputBuf.set(tabId, '')
    } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
      tabInputBuf.set(tabId, (tabInputBuf.get(tabId) || '') + data)
    } else if (data.length > 1 && !data.startsWith('\x1b')) {
      tabInputBuf.set(tabId, (tabInputBuf.get(tabId) || '') + data)
    }
  })

  // Handle resize (with tabId)
  ipcMain.on('terminal:resize', (_event: Electron.IpcMainEvent, tabId: string, cols: number, rows: number) => {
    const proc = ptyProcesses.get(tabId)
    if (proc) {
      try {
        proc.resize(cols, rows)
      } catch {
        // ignore resize errors
      }
    }
  })

  // Handle git branch request
  ipcMain.handle('git:branch', () => {
    return new Promise<string | null>((resolve) => {
      execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: HOME,
        encoding: 'utf-8',
        timeout: 5000,
      }, (err, stdout) => {
        resolve(err ? null : stdout.trim())
      })
    })
  })

  // Handle cwd request
  ipcMain.handle('system:cwd', async () => {
    return HOME
  })

  // ---- File tree ----
  const HIDDEN_DIRS = new Set(['node_modules', '.git', '.next', 'dist', '.cache', '__pycache__'])

  ipcMain.handle('fs:list-dir', async (_event, dirPath: string) => {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      return entries
        .filter((e) => {
          if (e.isDirectory() && HIDDEN_DIRS.has(e.name)) return false
          return true
        })
        .map((e) => ({
          name: e.name,
          path: path.join(dirPath, e.name),
          isDir: e.isDirectory(),
        }))
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
          return a.name.localeCompare(b.name)
        })
    } catch {
      return []
    }
  })

  ipcMain.handle('fs:open-in-editor', async (_event, filePath: string, editorCommand?: string) => {
    if (editorCommand && editorCommand.trim()) {
      execFile(editorCommand, [filePath], (err) => {
        if (err) shell.openPath(filePath)
      })
    } else {
      await shell.openPath(filePath)
    }
  })

  ipcMain.handle('clipboard:write', (_event, text: string) => {
    clipboard.writeText(text)
  })

  } // end ipcHandlersRegistered guard

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    // Save session before cleanup
    saveSession()

    for (const timer of tabTimers.values()) clearInterval(timer)
    tabTimers.clear()
    tabInfo.clear()
    tabInputBuf.clear()
    tabOrder.length = 0
    for (const proc of ptyProcesses.values()) proc.kill()
    ptyProcesses.clear()
    mainWindow = null
  })
}

app.whenReady().then(createWindow)

app.on('before-quit', (event) => {
  if (!quitConfirmPending) {
    event.preventDefault()
    quitConfirmPending = true
    mainWindow?.webContents.send('quit-confirm')
    quitConfirmTimer = setTimeout(() => {
      quitConfirmPending = false
      mainWindow?.webContents.send('quit-confirm-cancel')
    }, 3000)
  } else {
    if (quitConfirmTimer) { clearTimeout(quitConfirmTimer); quitConfirmTimer = null }
    saveSession()
  }
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
