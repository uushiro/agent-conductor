import { app, BrowserWindow, ipcMain, shell, clipboard, dialog, nativeImage } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import https from 'node:https'
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
// In-tab worker agents reported via [[AGENT: label :: model :: started|done]] markers.
// Runtime-only (not persisted to session.json) — cleared on tab close / app restart.
interface ActiveAgent { label: string; model: string; status: 'started' | 'done' }

const tabInfo = new Map<string, {
  cwd: string; proc: string; issue: string; latestInput: string
  claudeSessionId: string | null; claudeResumeParentId: string | null; hadClaude: boolean
  hadGemini: boolean; geminiSessionFile: string | null; hadCodex: boolean; resuming: boolean
  model: string | null
  activeAgents: ActiveAgent[]
}>()

// Normalize a model string to a known Claude model family (for the tab badge).
// Sources: launch args (--model sonnet) and the stdout startup banner ("Sonnet 5",
// "Opus 4.8", ...). Substring match, so version-suffixed banner forms normalize too.
// Unknown values return null and the badge is simply hidden.
function normalizeClaudeModel(raw: string): string | null {
  const s = raw.toLowerCase()
  if (s.includes('fable')) return 'fable'
  if (s.includes('opus')) return 'opus'
  if (s.includes('sonnet')) return 'sonnet'
  if (s.includes('haiku')) return 'haiku'
  return null
}

interface ClosedTabEntry {
  issue: string
  cwd: string
  claudeSessionId: string | null
  agent: 'claude' | 'gemini' | 'codex'
  closedAt: number
  model: string | null
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
// tabId → unscanned tail buffer for stdout startup-banner model detection
// (e.g. "Sonnet 5 with medium effort · Claude Max"). stdout is the ground truth for the
// actually-selected model: it covers plain `claude` launches (no --model) and resumes,
// and overrides the provisional --model input parse. Last detection wins.
const tabModelScanBuf = new Map<string, string>()
// Model family + optional version digits, anchored to the "·"/"•" separator of the banner
// line so bare mentions of model names (chat text, [[AGENT:]] markers) don't false-positive.
// Deliberately loose about the text in between ("with medium effort" etc. may change).
const MODEL_BANNER_RE = /\b(Opus|Sonnet|Haiku|Fable)\b[^\n·•]{0,40}[·•]/gi
// Deduplicate task emissions within a session (cleared on session:load)
const emittedTaskTitles = new Set<string>()
// tabId → timeout handle while watching for --resume failure ("No conversation found")
const tabResumeWatch = new Map<string, ReturnType<typeof setTimeout>>()

// --- In-tab worker agents ([[AGENT: label :: model :: started|done]]) ---
// Dedup: TUI repaints (scroll/resize/turn-end) can re-emit the same marker, so each
// exact marker (label::model::status) is processed once per tab. LRU-capped per tab.
const tabAgentMarkerKeys = new Map<string, Set<string>>()
const AGENT_MARKER_DEDUP_MAX_PER_TAB = 200

// Handle a detected [[AGENT: label :: model :: status]] marker from tab `tabId`.
// started → upsert into activeAgents (by label); done → remove the entry.
function handleAgentMarker(tabId: string, label: string, model: string, status: 'started' | 'done') {
  const key = `${label}::${model}::${status}`
  let keys = tabAgentMarkerKeys.get(tabId)
  if (!keys) { keys = new Set(); tabAgentMarkerKeys.set(tabId, keys) }
  if (keys.has(key)) return
  keys.add(key)
  while (keys.size > AGENT_MARKER_DEDUP_MAX_PER_TAB) {
    const oldest = keys.values().next().value as string
    keys.delete(oldest)
  }

  const info = tabInfo.get(tabId)
  if (!info) return
  if (status === 'started') {
    const normalized = normalizeClaudeModel(model) ?? model
    const existing = info.activeAgents.find((a) => a.label === label)
    if (existing) {
      existing.model = normalized
      existing.status = 'started'
    } else {
      info.activeAgents.push({ label, model: normalized, status: 'started' })
    }
  } else {
    info.activeAgents = info.activeAgents.filter((a) => a.label !== label)
  }
  tabInfo.set(tabId, info)
}

// --- Agent-to-agent messaging ([[SEND: dest :: body]]) ---
interface AgentMsg {
  fromTabId: string
  fromName: string
  toTabId: string
  body: string
  queuedAt: number
}
const agentMsgQueue: AgentMsg[] = []
// srcTabId → set of "dest::bodyHash" keys already sent from that tab (dedup: TUI redraws
// re-print the same [[SEND:]] indefinitely — scroll/resize/turn-end repaints can happen
// minutes later, so dedup lasts for the tab's whole lifetime, not a TTL).
// Cleared per-tab on terminal:close, globally on session:load. LRU-capped per tab.
const tabSentAgentMsgKeys = new Map<string, Set<string>>()
const AGENT_MSG_DEDUP_MAX_PER_TAB = 200

// Clean TUI line-wrap artifacts out of an extracted [[SEND:]] body.
// Claude TUI wraps long [[SEND:]] blocks at the pane width; every repaint after a
// resize/split re-wraps at a different column, injecting spaces/newlines mid-word
// ("天気予 報", "北 東の風"). Join the body back into one line:
//   - whitespace run flanked by wide (CJK etc., >= U+2E80) chars on BOTH sides → removed
//     (no legitimate space exists inside Japanese words)
//   - any other whitespace run → collapsed to a single space (preserves English word
//     boundaries; a residual space at a CJK/ASCII border is acceptable cosmetic noise)
function cleanAgentMsgBody(body: string): string {
  const isWide = (c: string) => c.charCodeAt(0) >= 0x2e80
  return body.trim().replace(/\s+/g, (ws: string, idx: number, str: string) => {
    const prev = str[idx - 1]
    const next = str[idx + ws.length]
    return prev && next && isWide(prev) && isWide(next) ? '' : ' '
  })
}

// Compact dedup key: [[SEND:]] bodies can be long, so hash them (djb2) instead of
// storing full text. Length is appended to further reduce collision odds.
// ALL whitespace is stripped before hashing: wrap positions differ between repaints
// (see cleanAgentMsgBody), so the same logical message must map to one key regardless
// of where spaces/newlines landed. Dest is normalized the same way.
function agentMsgDedupKey(dest: string, body: string): string {
  const normBody = body.replace(/\s+/g, '')
  const normDest = dest.replace(/\s+/g, '')
  let h = 5381
  for (let i = 0; i < normBody.length; i++) h = (Math.imul(h, 33) ^ normBody.charCodeAt(i)) >>> 0
  return `${normDest}::${h.toString(36)}:${normBody.length}`
}
// Destination is considered busy if its PTY produced output within this window
const AGENT_MSG_BUSY_MS = 3000

// Resolve a destination tab by issue (tab name): exact match first, then prefix match.
// Returns null when not found or ambiguous.
function resolveTabByName(name: string, excludeTabId: string): string | null {
  const candidates = tabOrder.filter((id) => id !== excludeTabId)
  const exact = candidates.filter((id) => (tabInfo.get(id)?.issue || '') === name)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) return null
  const prefix = candidates.filter((id) => {
    const issue = tabInfo.get(id)?.issue || ''
    return issue !== '' && issue.startsWith(name)
  })
  if (prefix.length === 1) return prefix[0]
  return null
}

// Inject a message into the destination PTY via bracketed paste, then submit with \r
function deliverAgentMsg(msg: AgentMsg) {
  const proc = ptyProcesses.get(msg.toTabId)
  if (!proc) return
  const text = `[from: ${msg.fromName}] ${msg.body}`
  proc.write('\x1b[200~' + text + '\x1b[201~')
  setTimeout(() => {
    const p = ptyProcesses.get(msg.toTabId)
    if (p) p.write('\r')
  }, 150)
  mainWindow?.webContents.send('agent-msg:notify', {
    type: 'delivered', from: msg.fromName, dest: tabInfo.get(msg.toTabId)?.issue || msg.toTabId, body: msg.body,
  })
}

// Parse a user-typed send command (lenient variants accepted):
//   [[SEND: <tab> :: <body>]]   (closing ]] optional)
//   SEND: <tab> :: <body>       (case-insensitive, spaces optional)
//   send:<tab>::<body>
//   send:<tab> <body>           (no "::" — dest is a single token after the colon)
// The "send:" prefix (with colon) is required for the space-separated form so that
// ordinary input like "send git diff" is never intercepted.
// Returns null when the line is not a send command.
function parseUserSendCommand(line: string): { dest: string; body: string } | null {
  // Full form: [[SEND: dest :: body]] — closing brackets optional for forgiving input
  let m = line.match(/^\[\[\s*SEND\s*:\s*(.+?)\s*::\s*([\s\S]+?)\s*(?:\]\])?\s*$/i)
  if (!m) {
    // Bare form: send:dest::body / SEND: dest :: body
    m = line.match(/^SEND\s*:\s*(.+?)\s*::\s*([\s\S]+?)\s*$/i)
  }
  if (!m) {
    // Space-separated form: send:dest body (dest = single token, no "::" required)
    m = line.match(/^SEND\s*:\s*(\S+)\s+([\s\S]+?)\s*$/i)
  }
  if (!m) return null
  const dest = m[1].trim()
  const body = m[2].trim()
  if (!dest || !body) return null
  return { dest, body }
}

// Handle a detected [[SEND: dest :: body]] from tab `fromTabId`.
// bypassDedup: the user-typed interception path (parseUserSendCommand) never reaches the
// PTY output stream, so it can't be re-detected by redraws — and a user re-typing the
// same text clearly intends a re-send. Output-side detection always goes through dedup.
function handleAgentSend(fromTabId: string, destName: string, body: string, opts?: { bypassDedup?: boolean }) {
  const now = Date.now()
  if (!opts?.bypassDedup) {
    // Output-side detections come from PTY repaints where the TUI may have re-wrapped
    // the [[SEND:]] block: normalize the dest and strip wrap artifacts from the body
    // so the delivered text is clean. (User-typed path is never wrapped — left as-is.)
    destName = destName.replace(/\s+/g, ' ').trim()
    body = cleanAgentMsgBody(body)
    let keys = tabSentAgentMsgKeys.get(fromTabId)
    if (!keys) {
      keys = new Set<string>()
      tabSentAgentMsgKeys.set(fromTabId, keys)
    }
    const key = agentMsgDedupKey(destName, body)
    if (keys.has(key)) {
      // Refresh LRU position so messages that keep reappearing in redraws stay blocked
      keys.delete(key)
      keys.add(key)
      return
    }
    keys.add(key)
    // LRU cap: evict oldest keys to bound memory per tab
    while (keys.size > AGENT_MSG_DEDUP_MAX_PER_TAB) {
      const oldest = keys.values().next().value as string
      keys.delete(oldest)
    }
  }

  const fromName = tabInfo.get(fromTabId)?.issue || fromTabId
  const toTabId = resolveTabByName(destName, fromTabId)
  if (!toTabId) {
    console.log(`[agent-msg] 宛先が見つからない: "${destName}" (from: ${fromName})`)
    mainWindow?.webContents.send('agent-msg:notify', {
      type: 'error', from: fromName, dest: destName, body,
    })
    return
  }
  // Always enqueue; the 1s poller delivers when the destination is idle (FIFO per destination)
  agentMsgQueue.push({ fromTabId, fromName, toTabId, body, queuedAt: now })
}

// Queue poller: deliver pending messages to idle destinations (at most 1 per destination per tick)
setInterval(() => {
  if (agentMsgQueue.length === 0) return
  const now = Date.now()
  const deliveredTo = new Set<string>()
  for (let i = 0; i < agentMsgQueue.length; ) {
    const msg = agentMsgQueue[i]
    if (!ptyProcesses.has(msg.toTabId)) {
      console.log(`[agent-msg] 宛先タブが閉じられたため破棄: ${msg.toTabId}`)
      agentMsgQueue.splice(i, 1)
      continue
    }
    const lastOut = tabLastOutputAt.get(msg.toTabId) ?? 0
    if (!deliveredTo.has(msg.toTabId) && now - lastOut >= AGENT_MSG_BUSY_MS) {
      agentMsgQueue.splice(i, 1)
      deliveredTo.add(msg.toTabId)
      deliverAgentMsg(msg)
      continue
    }
    i++
  }
}, 1000)

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
  hadCodex: boolean
  model: string | null
}

interface SavedSession {
  tabs: SavedTab[]
  activeIndex: number
}

const IS_DEV = process.env.NODE_ENV === 'development' || !!process.env.VITE_DEV_SERVER_URL
const SESSION_FILE = path.join(app.getPath('userData'), IS_DEV ? 'session-dev.json' : 'session.json')
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json')

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
        // Fallback: if no valid session was found, pick the most recent session
        // with conversation content for this cwd (handles /resume inside Claude
        // and cross-tab watcher contamination).
        if (!claudeSessionId) {
          const recentSessions = getRecentClaudeSessions(info.cwd || HOME)
          for (const sid of recentSessions.slice(0, 10)) {
            if (sessionHasConversation(sid, info.cwd || HOME)) {
              claudeSessionId = sid
              break
            }
          }
        }
      }

      tabs.push({
        issue: info.issue,
        cwd: info.cwd || HOME,
        hadClaude,
        claudeSessionId,
        hadGemini: info.hadGemini,
        hadCodex: info.hadCodex,
        model: info.model,
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

// Generate a short, clean issue title from the first user prompt
function autoTitle(input: string): string {
  let s = input.trim()
  // Remove common trailing patterns (Japanese verb endings + request forms)
  s = s.replace(/[をにでがはもへと]?(して|した|する|やって|教えて|調べて|確認して|作って|作成して|まとめて|リサーチして|見せて|出して|読んで|書いて|送って|開いて|ください|お願い|頼む|欲しい|したい|してほしい|しといて|んだけど.*)$/u, '')
  // Remove trailing particles
  s = s.replace(/[をにでがはもへと、。]$/u, '')
  // If result is too short, use original
  if (s.length < 3) return input.slice(0, 25)
  // Cap at 25 chars, break at natural boundary
  if (s.length > 25) {
    const cut = s.slice(0, 25)
    const breakMatch = cut.match(/^(.+[をにでがはもへと、。の])/u)
    s = breakMatch ? breakMatch[1].replace(/[をにでがはもへと、。]$/u, '') : cut
  }
  return s
}

function updateTabInfo(id: string, ptyProcess: ReturnType<typeof pty.spawn>) {
  const info = tabInfo.get(id) || { cwd: '', proc: '', issue: '', latestInput: '', claudeSessionId: null as string | null, claudeResumeParentId: null as string | null, hadClaude: false, hadGemini: false, geminiSessionFile: null as string | null, hadCodex: false, resuming: false, model: null as string | null, activeAgents: [] as ActiveAgent[] }
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
      if (info.proc === 'codex') info.hadCodex = true
      info.resuming = false
    } else if (prevProc !== '' && !SHELLS.has(prevProc) && SHELLS.has(info.proc)) {
      // Agent → shell: clear agent state
      if (prevProc === 'claude') {
        info.hadClaude = false
        info.claudeSessionId = null
        info.claudeResumeParentId = null
        info.model = null
      }
      if (prevProc === 'gemini') {
        info.hadGemini = false
        info.geminiSessionFile = null
      }
      if (prevProc === 'codex') {
        info.hadCodex = false
      }
      info.latestInput = ''
      tabInputBuf.delete(id)
    }
  }

  // cwd is now updated via OSC 7 escape sequences emitted by the shell hook.
  // No lsof call needed here.
  tabInfo.set(id, info)
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
      // Let agents inside the tab know they run under Agent Conductor
      // (enables [[SEND: <tab> :: <body>]] inter-tab messaging awareness)
      env.AGENT_CONDUCTOR = '1'
      return env
    })(),
  })

  ptyProcesses.set(id, ptyProcess)
  tabInfo.set(id, { cwd: initialCwd, proc: '', issue: '', latestInput: '', claudeSessionId: null, claudeResumeParentId: null, hadClaude: false, hadGemini: false, geminiSessionFile: null, hadCodex: false, resuming: false, model: null, activeAgents: [] })
  tabOrder.push(id)

  // Inject shell hook to emit OSC 7 on every prompt (cwd tracking without lsof).
  // OSC 7 format: \033]7;file://hostname/cwd\007
  // We wait a tick so the shell is ready to accept input.
  setTimeout(() => {
    const shellName = path.basename(shell)
    const hostname = os.hostname()
    if (shellName === 'zsh') {
      // precmd_functions is safe to append to even if user already defines precmd
      ptyProcess.write(`precmd_ac_cwd() { printf "\\033]7;file://${hostname}$PWD\\007"; }; precmd_functions+=(precmd_ac_cwd)\r`)
    } else if (shellName === 'bash') {
      ptyProcess.write(`PROMPT_COMMAND='printf "\\033]7;file://${hostname}$PWD\\007"; '"$PROMPT_COMMAND"\r`)
    } else if (shellName === 'fish') {
      ptyProcess.write(`function __ac_cwd --on-event fish_prompt; printf "\\033]7;file://${hostname}$PWD\\007"; end\r`)
    }
    // For other shells, OSC 7 won't be emitted; cwd stays as initialCwd
  }, 300)

  // Relay pty output → renderer, and buffer last output for sidebar
  // Also parse OSC 7 sequences to track cwd without lsof.
  ptyProcess.onData((data: string) => {
    // OSC 7: \033]7;file://hostname/path\007  or  \033]7;file://hostname/path\033\\
    const osc7 = data.match(/\x1b\]7;file:\/\/[^\x07\x1b]*(?:\x07|\x1b\\)/)
    if (osc7) {
      const urlMatch = osc7[0].match(/\x1b\]7;file:\/\/([^\x07\x1b/]*)([^\x07\x1b]*)/)
      if (urlMatch) {
        try {
          const decoded = decodeURIComponent(urlMatch[2])
          const info = tabInfo.get(id)
          if (info && decoded) {
            info.cwd = decoded
            tabInfo.set(id, info)
          }
        } catch { /* ignore decode errors */ }
      }
    }
    mainWindow?.webContents.send('terminal:data', id, data)
    const prev = tabLastOutput.get(id) || ''
    const combined = (prev + data).slice(-3000)
    tabLastOutput.set(id, combined)
    tabLastOutputAt.set(id, Date.now())

    // Detect the Claude Code startup-banner model line (e.g. "Sonnet 5 with medium effort · Claude Max").
    // Runs outside the [[TASK:]] resume cooldown on purpose: resume replay repaints the
    // banner too, and we want the badge to follow it. Same chunk-buffer/ANSI-strip scheme
    // as the [[TASK:]]/[[SEND:]] detectors; repaint duplicates are harmless (idempotent overwrite).
    {
      const overlap = tabModelScanBuf.get(id) || ''
      const scanBuf = (overlap + data)
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        .replace(/\r/g, '')
      let lastMatchEnd = 0
      let detected: string | null = null
      for (const m of scanBuf.matchAll(MODEL_BANNER_RE)) {
        const normalized = normalizeClaudeModel(m[1])
        if (normalized) detected = normalized // last detection wins
        lastMatchEnd = m.index! + m[0].length
      }
      if (detected) {
        const info = tabInfo.get(id)
        if (info && info.model !== detected) {
          info.model = detected
          tabInfo.set(id, info)
        }
      }
      // Keep only the unmatched tail for split-chunk detection (banner line is short)
      tabModelScanBuf.set(id, scanBuf.slice(Math.max(lastMatchEnd, scanBuf.length - 200)))
    }

    // Detect --resume failure: "No conversation found" → fall back to fresh claude
    if (tabResumeWatch.has(id)) {
      const stripped = combined
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
        .replace(/\x1b\][^\x07\x1b]*\x07/g, '')
        .replace(/\r/g, '')
      if (/No conversation found with session ID/i.test(stripped)) {
        clearTimeout(tabResumeWatch.get(id)!)
        tabResumeWatch.delete(id)
        const info = tabInfo.get(id)
        if (info) {
          info.claudeSessionId = null
          info.claudeResumeParentId = null
          info.hadClaude = true
          // Fallback retries with plain `claude` (no --model) → model is unknown
          info.model = null
          tabInfo.set(id, info)
        }
        // Wait for error to finish printing, then retry with plain claude
        setTimeout(() => {
          const proc = ptyProcesses.get(id)
          if (proc) {
            proc.write('claude\r')
            // Re-start session watcher so the fresh claude's session file gets detected
            const cwd = info?.cwd || HOME
            startSessionWatch(id, cwd)
          }
        }, 1500)
      }
    }

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
        lastMatchEnd = Math.max(lastMatchEnd, match.index! + match[0].length)
      }
      // Detect [[SEND: dest :: body]] pattern — agent-to-agent message routing
      for (const match of stripped.matchAll(/\[\[SEND:\s*([^\]:]+?)\s*::\s*([\s\S]+?)\]\]/g)) {
        const dest = match[1].trim()
        const body = match[2].trim()
        if (dest && body) handleAgentSend(id, dest, body)
        lastMatchEnd = Math.max(lastMatchEnd, match.index! + match[0].length)
      }
      // Detect [[AGENT: label :: model :: started|done]] pattern — in-tab worker tracking
      for (const match of stripped.matchAll(/\[\[AGENT:\s*([^\]:]+?)\s*::\s*([^\]:]+?)\s*::\s*(started|done)\s*\]\]/g)) {
        const label = match[1].trim()
        const model = match[2].trim()
        if (label && model) handleAgentMarker(id, label, model, match[3] as 'started' | 'done')
        lastMatchEnd = Math.max(lastMatchEnd, match.index! + match[0].length)
      }
      // Keep only the unmatched tail for split-chunk detection
      // (500 chars: [[SEND:]] bodies can be long and split across chunks)
      tabTaskScanBuf.set(id, stripped.slice(Math.max(lastMatchEnd, stripped.length - 500)))
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
    backgroundColor: '#0d1117',
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
      info.resuming = true
      tabInfo.set(id, info)
    }
    return id
  })

  // Get title for a tab (poll from renderer)
  ipcMain.handle('terminal:get-title', (_event, tabId: string) => {
    const info = tabInfo.get(tabId)
    if (!info) return { issue: '', detail: 'Terminal', model: null, activeAgents: [] }
    const result: { issue: string; detail: string; model: string | null; activeAgents: ActiveAgent[] } = { ...getTabTitle(info), model: info.model, activeAgents: info.activeAgents }
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
        const isCodexRunning = !!info?.hadCodex && !!info?.proc && !SHELLS.has(info.proc)
        const isAgentRunning = isClaudeRunning || isGeminiRunning || isCodexRunning
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

        if (!info) return { id, cwd: '', proc: '', issue: '', latestInput: '', claudeSessionId: null, lastOutput: '', active, lastInputAt, isThinking: false, isResuming: false, model: null, activeAgents: [] }
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
          isResuming: info.resuming,
          model: info.model,
          activeAgents: info.activeAgents,
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
    agentMsgQueue.length = 0
    tabSentAgentMsgKeys.clear()
    for (const t of tabResumeWatch.values()) clearTimeout(t)
    tabResumeWatch.clear()
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
          model: closingInfo.model,
        })
        if (closedTabsHistory.length > 10) closedTabsHistory.pop()
      }
    } else if (closingInfo?.hadGemini) {
      const sessionFile = closingInfo.geminiSessionFile || getLastGeminiSessionFile(closingInfo.cwd || HOME)
      if (sessionFile) {
        closedTabsHistory.unshift({
          issue: closingInfo.issue, cwd: closingInfo.cwd || HOME,
          claudeSessionId: null, agent: 'gemini', closedAt: Date.now(),
          model: null,
        })
        if (closedTabsHistory.length > 10) closedTabsHistory.pop()
      }
    } else if (closingInfo?.hadCodex) {
      closedTabsHistory.unshift({
        issue: closingInfo.issue, cwd: closingInfo.cwd || HOME,
        claudeSessionId: null, agent: 'codex', closedAt: Date.now(),
        model: null,
      })
      if (closedTabsHistory.length > 10) closedTabsHistory.pop()
    }

    const timer = tabTimers.get(tabId)
    if (timer) { clearInterval(timer); tabTimers.delete(tabId) }
    tabInfo.delete(tabId)
    tabInputBuf.delete(tabId)
    tabLastOutput.delete(tabId)
    tabLastOutputAt.delete(tabId)
    tabLastInputAt.delete(tabId)
    tabTaskScanBuf.delete(tabId)
    tabModelScanBuf.delete(tabId)
    tabSentAgentMsgKeys.delete(tabId)
    tabAgentMarkerKeys.delete(tabId)
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
    return !!(info?.hadClaude || info?.hadGemini || info?.hadCodex)
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

    // Strip bracketed-paste markers for parsing only (PTY still receives raw data).
    // This lets pasted text participate in input-line analysis below.
    const parsed = data.replace(/\x1b\[20[01]~/g, '')
    const isEnter = parsed === '\r' || (parsed.includes('\r') && parsed.length > 1)

    // --- User-typed send command interception ---
    // If the submitted line is a [[SEND:]] command (or lenient variant), route it
    // directly instead of passing it to the in-tab agent.
    if (proc && isEnter) {
      const buffered = tabInputBuf.get(tabId) || ''
      const batch = parsed !== '\r' ? parsed.split('\r')[0] : ''
      const send = parseUserSendCommand((buffered + batch).trim())
      if (send) {
        tabInputBuf.set(tabId, '')
        // Chars typed/pasted before Enter were already echoed into the tab's
        // input line — erase them with backspaces (works in shells and agent TUIs)
        if (buffered.length > 0) proc.write('\x7f'.repeat(Array.from(buffered).length))
        const fromName = tabInfo.get(tabId)?.issue || tabId
        console.log(`[agent-msg] ユーザー入力からSEND検出: ${fromName} → ${send.dest}`)
        mainWindow?.webContents.send('agent-msg:notify', {
          type: 'queued', from: fromName, dest: send.dest, body: send.body,
        })
        // User-typed sends bypass dedup: explicit re-sends of the same text are intentional,
        // and this path never echoes into PTY output so redraw multi-delivery can't happen.
        handleAgentSend(tabId, send.dest, send.body, { bypassDedup: true })
        return // do NOT forward this input to the PTY
      }
    }

    if (proc) {
      proc.write(data)
    }

    const info = tabInfo.get(tabId)
    if (!info) return

    const isShell = !info.proc || SHELLS.has(info.proc)

    if (isEnter) {
      // Extract the command (handles both single '\r' and batch 'command\r')
      const buffered = tabInputBuf.get(tabId) || ''
      const batchCmd = parsed !== '\r' ? parsed.split('\r')[0] : ''
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

        // Detect "codex" command being launched from shell
        if (/^codex(\s|$)/.test(input)) {
          info.hadCodex = true
          tabInfo.set(tabId, info)
        }

        // Detect "claude" command being launched from shell → snapshot NOW before file is created
        if (/^claude(\s|$)/.test(input)) {
          info.hadClaude = true
          // Machine-detect the model from the launch args (--model sonnet / --model=sonnet).
          // Provisional (user intent, shown immediately); the stdout startup-banner
          // detection overwrites it with the actually-selected model once claude prints it.
          // No flag or unknown value → null until the banner is detected.
          const modelMatch = input.match(/--model[=\s]+(\S+)/)
          info.model = modelMatch ? normalizeClaudeModel(modelMatch[1]) : null
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
            // Watch for resume failure; auto-fallback to plain claude if detected
            const prevWatch = tabResumeWatch.get(tabId)
            if (prevWatch) clearTimeout(prevWatch)
            tabResumeWatch.set(tabId, setTimeout(() => tabResumeWatch.delete(tabId), 15000))
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
          if (!info.issue) info.issue = autoTitle(input)
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
    } else if (parsed.length === 1 && parsed.charCodeAt(0) >= 32) {
      tabInputBuf.set(tabId, (tabInputBuf.get(tabId) || '') + parsed)
    } else if (parsed.length > 1 && !parsed.startsWith('\x1b')) {
      // Includes bracketed-paste content (markers stripped above)
      tabInputBuf.set(tabId, (tabInputBuf.get(tabId) || '') + parsed)
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

  const ALLOWED_EDITORS = new Set(['code', 'cursor', 'vim', 'nvim', 'subl', 'nano', 'emacs'])

  ipcMain.handle('fs:open-in-editor', async (_event, filePath: string, editorCommand?: string) => {
    if (editorCommand && editorCommand.trim()) {
      const cmd = editorCommand.trim()
      if (!ALLOWED_EDITORS.has(cmd)) {
        await shell.openPath(filePath)
        return
      }
      execFile(cmd, [filePath], (err) => {
        if (err) shell.openPath(filePath)
      })
    } else {
      await shell.openPath(filePath)
    }
  })

  ipcMain.handle('clipboard:write', (_event, text: string) => {
    if (process.platform === 'darwin') {
      // __CF_USER_TEXT_ENCODING が Mac Japanese (Shift-JIS) の環境では
      // clipboard.writeText / pbcopy がどちらも UTF-8 を Shift-JIS として書く。
      // writeBuffer で UTI を明示して回避する。
      clipboard.writeBuffer('public.utf8-plain-text', Buffer.from(text, 'utf8'))
    } else {
      clipboard.writeText(text)
    }
  })

  ipcMain.handle('clipboard:write-image', (_event, filePath: string) => {
    const img = nativeImage.createFromPath(filePath)
    if (!img.isEmpty()) {
      clipboard.writeImage(img)
      return true
    }
    return false
  })

  ipcMain.handle('clipboard:save-image', (_event, filePath: string) => {
    const img = clipboard.readImage()
    if (img.isEmpty()) return false
    const png = img.toPNG()
    require('fs').writeFileSync(filePath, png)
    return true
  })

  ipcMain.handle('window:paste', () => {
    mainWindow?.webContents.paste()
  })

  ipcMain.handle('dialog:open-file', async () => {
    if (!mainWindow) return []
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('settings:load', () => {
    try {
      if (fs.existsSync(SETTINGS_FILE)) {
        return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'))
      }
    } catch {}
    return null
  })

  ipcMain.on('settings:save', (_event, data: string) => {
    try { fs.writeFileSync(SETTINGS_FILE, data) } catch {}
  })

  ipcMain.on('shell:open-url', (_event, url: string) => {
    shell.openExternal(url)
  })

  // Resume sessions: list Claude session files from ~/.claude/projects/
  ipcMain.handle('resume:list-sessions', async (_event, projectDirs: string[] | null) => {
    const claudeDir = path.join(os.homedir(), '.claude', 'projects')
    let dirs: string[]
    if (projectDirs && projectDirs.length > 0) {
      dirs = projectDirs
    } else {
      try {
        dirs = fs.readdirSync(claudeDir)
          .map((d) => path.join(claudeDir, d))
          .filter((d) => fs.statSync(d).isDirectory())
      } catch {
        dirs = []
      }
    }

    const sessions: Array<{
      id: string
      title: string
      projectDir: string
      updatedAt: number
      sizeBytes: number
    }> = []

    for (const dir of dirs) {
      let files: string[]
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
      } catch {
        continue
      }
      for (const file of files) {
        const filePath = path.join(dir, file)
        let stat: fs.Stats
        try { stat = fs.statSync(filePath) } catch { continue }
        const id = file.replace('.jsonl', '')
        // Read first few KB to extract title (first user message)
        let title = id
        try {
          const buf = Buffer.alloc(2048)
          const fd = fs.openSync(filePath, 'r')
          const bytesRead = fs.readSync(fd, buf, 0, 2048, 0)
          fs.closeSync(fd)
          const text = buf.toString('utf8', 0, bytesRead)
          for (const line of text.split('\n')) {
            if (!line.trim()) continue
            try {
              const obj = JSON.parse(line)
              if (obj.type === 'user' && obj.parentUuid === null) {
                const content = obj.message?.content
                if (typeof content === 'string' && content.trim()) {
                  title = content.trim().split('\n')[0].slice(0, 120)
                } else if (Array.isArray(content)) {
                  const textPart = content.find((c: { type: string; text?: string }) => c.type === 'text')
                  if (textPart?.text) title = textPart.text.trim().split('\n')[0].slice(0, 120)
                }
                break
              }
            } catch { /* skip malformed lines */ }
          }
        } catch { /* skip on read error */ }

        sessions.push({
          id,
          title,
          projectDir: dir,
          updatedAt: stat.mtimeMs,
          sizeBytes: stat.size,
        })
      }
    }

    sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    return sessions
  })

  } // end ipcHandlersRegistered guard

  if (VITE_DEV_SERVER_URL && process.env.NODE_ENV === 'development') {
    mainWindow.loadURL(VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  // Check for updates 3 seconds after launch (allow window to settle)
  setTimeout(checkForUpdates, 3000)

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

function checkForUpdates() {
  const currentVersion = app.getVersion()
  const options = {
    hostname: 'api.github.com',
    path: '/repos/uushiro/agent-conductor/releases/latest',
    headers: { 'User-Agent': 'agent-conductor' },
  }
  https.get(options, (res) => {
    let data = ''
    res.on('data', (chunk) => { data += chunk })
    res.on('end', () => {
      try {
        const release = JSON.parse(data)
        const latestVersion = (release.tag_name as string)?.replace(/^v/, '')
        if (latestVersion && latestVersion !== currentVersion) {
          mainWindow?.webContents.send('update:available', latestVersion, release.html_url as string)
        }
      } catch { /* ignore parse errors */ }
    })
  }).on('error', () => { /* ignore network errors */ })
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
