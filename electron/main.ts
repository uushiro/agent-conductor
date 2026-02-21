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
const tabInfo = new Map<string, { cwd: string; proc: string; issue: string; latestInput: string; claudeSessionId: string | null }>()
const tabInputBuf = new Map<string, string>()
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
      const hadClaude = !SHELLS.has(info.proc) && info.proc !== ''
      tabs.push({
        issue: info.issue,
        cwd: info.cwd || HOME,
        hadClaude,
        claudeSessionId: hadClaude ? info.claudeSessionId : null,
      })
    }
  }
  const session: SavedSession = { tabs, activeIndex: 0 }
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

function updateTabInfo(id: string, ptyProcess: ReturnType<typeof pty.spawn>) {
  const info = tabInfo.get(id) || { cwd: '', proc: '', issue: '', latestInput: '', claudeSessionId: null as string | null }
  const prevProc = info.proc

  try {
    info.proc = ptyProcess.process || ''
  } catch { /* ignore */ }

  // When returning to shell from an app, clear latestInput (keep issue)
  if (!SHELLS.has(prevProc) && SHELLS.has(info.proc)) {
    info.latestInput = ''
    tabInputBuf.delete(id)
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
  tabInfo.set(id, { cwd: initialCwd, proc: '', issue: '', latestInput: '', claudeSessionId: null })
  tabOrder.push(id)

  // Relay pty output → renderer
  ptyProcess.onData((data: string) => {
    mainWindow?.webContents.send('terminal:data', id, data)
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

  // Load saved session
  ipcMain.handle('session:load', () => {
    return loadSession()
  })

  // Close a terminal tab
  ipcMain.on('terminal:close', (_event: Electron.IpcMainEvent, tabId: string) => {
    const timer = tabTimers.get(tabId)
    if (timer) { clearInterval(timer); tabTimers.delete(tabId) }
    tabInfo.delete(tabId)
    tabInputBuf.delete(tabId)
    const idx = tabOrder.indexOf(tabId)
    if (idx !== -1) tabOrder.splice(idx, 1)
    const proc = ptyProcesses.get(tabId)
    if (proc) {
      proc.kill()
      ptyProcesses.delete(tabId)
    }
  })

  // Relay renderer input → pty, and capture prompts for non-shell processes
  ipcMain.on('terminal:input', (_event: Electron.IpcMainEvent, tabId: string, data: string) => {
    const proc = ptyProcesses.get(tabId)
    if (proc) {
      proc.write(data)
    }

    const info = tabInfo.get(tabId)
    if (!info || SHELLS.has(info.proc)) return

    // Buffer keyboard input for non-shell processes
    if (data === '\r') {
      // Enter pressed — capture as issue (first time) and latestInput
      const input = (tabInputBuf.get(tabId) || '').trim()
      if (input.length > 0) {
        const truncated = input.length > 50 ? input.slice(0, 50) + '…' : input
        if (!info.issue) info.issue = truncated
        info.latestInput = truncated
        tabInfo.set(tabId, info)
      }
      tabInputBuf.set(tabId, '')

      // After a delay, detect which session file was just updated → assign to this tab
      const infoCwd = info.cwd
      setTimeout(() => {
        const sessions = getRecentClaudeSessions(infoCwd)
        if (sessions.length > 0) {
          const latestInfo = tabInfo.get(tabId)
          if (latestInfo) {
            latestInfo.claudeSessionId = sessions[0]
            tabInfo.set(tabId, latestInfo)
          }
        }
      }, 3000)
    } else if (data === '\x7f' || data === '\b') {
      // Backspace
      const buf = tabInputBuf.get(tabId) || ''
      tabInputBuf.set(tabId, buf.slice(0, -1))
    } else if (data === '\x03' || data === '\x04') {
      // Ctrl+C / Ctrl+D — clear buffer
      tabInputBuf.set(tabId, '')
    } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
      // Printable character
      tabInputBuf.set(tabId, (tabInputBuf.get(tabId) || '') + data)
    } else if (data.length > 1 && !data.startsWith('\x1b')) {
      // Pasted text
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
