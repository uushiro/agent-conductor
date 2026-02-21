import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { execFile } from 'node:child_process'

// node-pty is a native module — require it
const pty = require('node-pty')

let mainWindow: BrowserWindow | null = null

const SHELLS = new Set(['zsh', 'bash', 'fish', 'sh', 'login'])

// Map of tabId → pty instance
const ptyProcesses = new Map<string, ReturnType<typeof pty.spawn>>()
const tabTimers = new Map<string, ReturnType<typeof setInterval>>()
const tabInfo = new Map<string, { cwd: string; proc: string; issue: string; latestInput: string; claudeSessionId: string | null; hadClaude: boolean }>()
const tabInputBuf = new Map<string, string>()
const tabLastOutput = new Map<string, string>()
const tabLastOutputAt = new Map<string, number>()
const tabSessionWatchers = new Map<string, ReturnType<typeof setInterval>>()

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
      // Only save sessionId if the file has actual conversation content
      const claudeSessionId = (hadClaude && info.claudeSessionId && sessionHasConversation(info.claudeSessionId, info.cwd || HOME))
        ? info.claudeSessionId
        : null
      tabs.push({
        issue: info.issue,
        cwd: info.cwd || HOME,
        hadClaude,
        claudeSessionId,
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

// Watch for a new Claude session file when Claude starts in a tab
function startSessionWatch(tabId: string, cwd: string) {
  const existing = tabSessionWatchers.get(tabId)
  if (existing) { clearInterval(existing); tabSessionWatchers.delete(tabId) }

  const encoded = cwd.replace(/\//g, '-')
  const sessionDir = path.join(HOME, '.claude', 'projects', encoded)

  // Snapshot files that exist before Claude starts
  let knownFiles: Set<string>
  try {
    knownFiles = new Set(fs.readdirSync(sessionDir).filter((f: string) => f.endsWith('.jsonl')))
  } catch {
    knownFiles = new Set()
  }

  // Poll for the new .jsonl file Claude creates on startup
  const watcher = setInterval(() => {
    try {
      const current = fs.readdirSync(sessionDir).filter((f: string) => f.endsWith('.jsonl'))
      for (const file of current) {
        if (!knownFiles.has(file)) {
          const sessionId = file.replace('.jsonl', '')
          const info = tabInfo.get(tabId)
          if (info) {
            info.claudeSessionId = sessionId
            tabInfo.set(tabId, info)
          }
          clearInterval(watcher)
          tabSessionWatchers.delete(tabId)
          return
        }
      }
    } catch { /* ignore */ }
  }, 1000)

  tabSessionWatchers.set(tabId, watcher)
  setTimeout(() => {
    const w = tabSessionWatchers.get(tabId)
    if (w === watcher) { clearInterval(watcher); tabSessionWatchers.delete(tabId) }
  }, 30000)
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

function updateTabInfo(id: string, ptyProcess: ReturnType<typeof pty.spawn>) {
  const info = tabInfo.get(id) || { cwd: '', proc: '', issue: '', latestInput: '', claudeSessionId: null as string | null }
  const prevProc = info.proc

  try {
    info.proc = ptyProcess.process || ''
  } catch { /* ignore */ }

  // When process changes (shell↔app), clear output buffer
  if (prevProc !== info.proc) {
    tabLastOutput.delete(id)
    tabLastOutputAt.delete(id)
    if (SHELLS.has(prevProc) && !SHELLS.has(info.proc) && info.proc !== '') {
      // Shell → app: mark hadClaude (session watch already started at claude\r time)
      info.hadClaude = true
    } else if (prevProc !== '' && !SHELLS.has(prevProc) && SHELLS.has(info.proc)) {
      // App → shell (only when previously running a real non-shell process): clear
      info.hadClaude = false
      info.claudeSessionId = null
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
  tabInfo.set(id, { cwd: initialCwd, proc: '', issue: '', latestInput: '', claudeSessionId: null, hadClaude: false })
  tabOrder.push(id)

  // Relay pty output → renderer, and buffer last output for sidebar
  ptyProcess.onData((data: string) => {
    mainWindow?.webContents.send('terminal:data', id, data)
    const prev = tabLastOutput.get(id) || ''
    const combined = (prev + data).slice(-500)
    tabLastOutput.set(id, combined)
    tabLastOutputAt.set(id, Date.now())
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
    title: 'Claude Cockpit',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Create a new terminal tab (optional cwd)
  ipcMain.handle('terminal:create', (_event, cwd?: string) => {
    const { id } = spawnPty(cwd)
    return id
  })

  // Get title for a tab (poll from renderer)
  ipcMain.handle('terminal:get-title', (_event, tabId: string) => {
    const info = tabInfo.get(tabId)
    if (!info) return { issue: '', detail: 'Terminal' }
    return getTabTitle(info)
  })

  // Set issue from renderer (manual rename)
  ipcMain.handle('terminal:set-issue', (_event, tabId: string, issue: string) => {
    const info = tabInfo.get(tabId)
    if (info) {
      info.issue = issue
      tabInfo.set(tabId, info)
    }
  })

  // List all tab info (for sidebar), sorted by most recently active first
  ipcMain.handle('terminal:list-info', () => {
    const now = Date.now()
    return [...tabOrder]
      .map((id) => {
        const info = tabInfo.get(id)
        const lastOutput = extractLastLine(tabLastOutput.get(id) || '')
        const lastOutputAt = tabLastOutputAt.get(id) ?? 0
        const active = (now - lastOutputAt) < 2000
        if (!info) return { id, cwd: '', proc: '', issue: '', latestInput: '', claudeSessionId: null, lastOutput: '', active, lastOutputAt }
        return {
          id,
          cwd: info.cwd,
          proc: info.proc,
          issue: info.issue,
          latestInput: info.latestInput,
          claudeSessionId: info.claudeSessionId,
          lastOutput,
          active,
          lastOutputAt,
        }
      })
      .sort((a, b) => b.lastOutputAt - a.lastOutputAt)
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
    for (const w of tabSessionWatchers.values()) clearInterval(w)
    tabSessionWatchers.clear()
    tabOrder.length = 0
    tabCounter = 0

    return loadSession()
  })

  // Close a terminal tab
  ipcMain.on('terminal:close', (_event: Electron.IpcMainEvent, tabId: string) => {
    const timer = tabTimers.get(tabId)
    if (timer) { clearInterval(timer); tabTimers.delete(tabId) }
    tabInfo.delete(tabId)
    tabInputBuf.delete(tabId)
    tabLastOutput.delete(tabId)
    tabLastOutputAt.delete(tabId)
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
        // Detect "claude" command being launched from shell → snapshot NOW before file is created
        if (/^claude(\s|$)/.test(input)) {
          info.hadClaude = true
          // If resuming a specific session, save the ID directly
          const resumeMatch = input.match(/--resume\s+([a-f0-9-]{36})/)
          if (resumeMatch) {
            info.claudeSessionId = resumeMatch[1]
            tabInfo.set(tabId, info)
          } else {
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
  ipcMain.handle('git:branch', async () => {
    const { execSync } = require('child_process')
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD 2>/dev/null', {
        cwd: HOME,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
      return branch
    } catch {
      return null
    }
  })

  // Handle cwd request
  ipcMain.handle('system:cwd', async () => {
    return HOME
  })

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

app.on('window-all-closed', () => {
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
