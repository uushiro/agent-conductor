import { app, BrowserWindow, ipcMain, shell, clipboard, dialog, nativeImage } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import https from 'node:https'
import { randomUUID } from 'node:crypto'
import { readHandoffSession, buildHandoffPrompt } from './agent-handoff.mjs'
import { AgentSwitchController } from './agent-switch.mjs'
import { HandoffDrafts } from './handoff-draft.mjs'
import { execFile } from 'node:child_process'
import { readClaudeSessionTitle } from './claude-session-title.mjs'

// node-pty is a native module — require it
const pty = require('node-pty')

// Dev and packaged-prod builds must never share a userData directory: a shared
// directory let dev test runs (session-dev.json etc.) write into the same folder
// as the packaged app and previously caused dev data to leak into prod. Redirect
// dev's userData to a sibling directory before any other Electron API call reads
// or writes into it. Same dev condition as the session-dev.json branch below.
if (process.env.NODE_ENV === 'development' || !!process.env.VITE_DEV_SERVER_URL) {
  app.setPath('userData', path.join(app.getPath('appData'), 'agent-conductor-dev'))
}

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
// `done` entries linger (doneAt + AGENT_DONE_LINGER_MS) so the 完了(green) state is
// visible for a while instead of vanishing instantly; pruned lazily on IPC polls.
interface ActiveAgent { label: string; model: string; status: 'started' | 'done'; doneAt?: number }

// Aggregate per-tab agent status for the tab-bar color coding:
// 'error' (red blinking, critical API/auth error needs a human NOW) /
// 'running' (blue) / 'attention' (yellow blinking, a select prompt awaits an answer) /
// 'waiting' (purple, quiet but no prompt detected) / 'done' (green) / 'none'
type TabAgentStatus = 'error' | 'running' | 'attention' | 'waiting' | 'done' | 'none'

const tabInfo = new Map<string, {
  cwd: string; proc: string; issue: string; latestInput: string
  claudeSessionId: string | null; claudeResumeParentId: string | null; hadClaude: boolean
  hadGemini: boolean; geminiSessionFile: string | null; hadCodex: boolean; codexSessionId: string | null; resuming: boolean
  // Display model (tab badge). Last-wins from any source: --model input parse,
  // stdout startup banner, hook-inherited markers. NEVER used to build a launch command.
  model: string | null
  // Launch-flag model. Set ONLY when the user explicitly typed/chose `--model X`
  // (model chip → `claude --model X`, or hand-typed). Banner detection must not touch it.
  // This is what saveSession()/closed-history persist, so a plain `claude` launch that
  // happened to run on Sonnet is not pinned to `--model sonnet` on the next restore
  // (which would silently override the `model` default in ~/.claude/settings.json).
  launchModel: string | null
  activeAgents: ActiveAgent[]
  // Manual rename waiting for the CLI watcher to discover a new session ID.
  pendingSessionTitle: string | null
  // Timestamp of the last quick-answer chip send ('terminal:send-choice').
  // Used to suppress stale prompt chips until new PTY output arrives.
  lastChoiceSentAt?: number
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
  codexSessionId: string | null
  agent: 'claude' | 'gemini' | 'codex'
  closedAt: number
  // Launch-flag model (tabInfo.launchModel), replayed as `claude --model X` on reopen.
  model: string | null
}
const closedTabsHistory: ClosedTabEntry[] = []
const tabInputBuf = new Map<string, string>()
const tabInputUncertain = new Map<string, boolean>()
const tabLastOutput = new Map<string, string>()
const tabLastOutputAt = new Map<string, number>()
const tabLastInputAt = new Map<string, number>()
const tabSessionWatchers = new Map<string, ReturnType<typeof setInterval>>()
const tabGeminiSessionWatchers = new Map<string, ReturnType<typeof setInterval>>()
const tabCodexSessionWatchers = new Map<string, ReturnType<typeof setInterval>>()
// tabId → timestamp until which [[SEND:]] detection is suppressed (resume replay window)
const tabResumeCooldown = new Map<string, number>()
const RESUME_COOLDOWN_MS = 60000
// tabId → unscanned tail buffer for [[SEND:]] detection (consumed on match to prevent re-detection)
const tabDetectScanBuf = new Map<string, string>()
// tabId → unscanned tail buffer for stdout startup-banner model detection
// (e.g. "Sonnet 5 with medium effort · Claude Max"). stdout is the ground truth for the
// actually-selected model: it covers plain `claude` launches (no --model) and resumes,
// and overrides the provisional --model input parse. Last detection wins.
const tabModelScanBuf = new Map<string, string>()
// Genuine banner model line: "Sonnet 5 with medium effort · Claude Max". Requires
// (1) version digits right after the model name (whitespace-separated, so URL slugs like
//     "claude-fable-5-promotional-access" can't match), and
// (2) "· Claude <plan>" as right context (the plan segment always starts with "Claude").
// This kills promo-text false positives (e.g. the "Fable 5 is back ..." banner, whose
// support URL followed by the "◐ medium · /effort" status line matched the old loose
// pattern). Still deliberately loose about the middle ("with medium effort" may change).
// Note: after CSI stripping, cursor-movement sequences vanish and rows concatenate
// without newlines — so no line anchors, and no proximity to "Claude Code vX.Y.Z"
// (the What's-new box sits between them) can be relied on.
const MODEL_BANNER_RE = /\b(Opus|Sonnet|Haiku|Fable)\s+\d[\d.]*[^\n·•]{0,40}[·•]\s*Claude\b/gi
// tabId → unscanned RAW tail buffer for OSC 777 AGENT-marker detection. Claude Code hooks
// emit markers mechanically as \x1b]777;notify;AGENT;[[AGENT: label :: model :: status]]\x07
// (BEL or ST terminated). This must be scanned on the raw pty stream BEFORE any ANSI/OSC
// stripping — the generic OSC strip regexes would swallow the whole sequence.
const tabAgentOscBuf = new Map<string, string>()
// OSC 777 AGENT envelope: capture the body up to BEL (\x07) or ST (\x1b\\)
const AGENT_OSC_RE = /\x1b\]777;notify;AGENT;([^\x07\x1b]*)(?:\x07|\x1b\\)/g
// The [[AGENT: label :: model :: started|done]] marker itself. Only matched inside the
// OSC 777 envelope above — plain-text [[AGENT:]] on the PTY stream is deliberately
// ignored (external content echoed to the terminal could otherwise forge agent badges).
const AGENT_MARKER_RE = /\[\[AGENT:\s*([^\]:]+?)\s*::\s*([^\]:]+?)\s*::\s*(started|done)\s*\]\]/g
// tabId → timeout handle while watching for --resume failure ("No conversation found")
const tabResumeWatch = new Map<string, ReturnType<typeof setTimeout>>()

// --- In-tab worker agents ([[AGENT: label :: model :: started|done]]) ---
// Dedup: physical re-emissions of the same marker (TUI repaints, chunk overlap re-scans)
// are ignored for a short TTL window, NOT for the tab's lifetime — the same label can
// legitimately be started again later (started → done → started must count twice).
// The window slides: each duplicate sighting refreshes the timestamp, so a marker being
// repainted continuously stays suppressed, but a genuinely new run after quiet time passes.
// Additionally, a `done` clears the label's `started` dedup records so an immediate
// relaunch of the same label is never blocked. LRU-capped per tab.
const tabAgentMarkerSeen = new Map<string, Map<string, number>>() // tabId → (marker key → last seen ms)
const AGENT_MARKER_DEDUP_TTL_MS = 5000
const AGENT_MARKER_DEDUP_MAX_PER_TAB = 200
// How long a `done` agent entry stays visible (完了/green) before being pruned
const AGENT_DONE_LINGER_MS = 8000

// Drop `done` entries whose linger window has expired. Called lazily from the
// polling IPC handlers (get-title / list-info) — no per-entry timers needed.
function pruneDoneAgents(info: { activeAgents: ActiveAgent[] }) {
  const now = Date.now()
  const kept = info.activeAgents.filter(
    (a) => a.status !== 'done' || now - (a.doneAt ?? 0) < AGENT_DONE_LINGER_MS
  )
  if (kept.length !== info.activeAgents.length) info.activeAgents = kept
}

// Compute the tab's aggregate agent status (see TabAgentStatus).
// The silent-tab approximation (agent CLI in the foreground but the PTY quiet for
// > 3 s) splits in two: 'attention' when extractPromptChoices actually detects a
// select prompt (a human answer is needed now), 'waiting' otherwise (just quiet,
// no urgent action). Lingering `done` workers show 'done' only once nothing is running.
// 'error' takes precedence over everything (checked even while output is flowing —
// an error banner must turn the tab red immediately, without the 3 s silence wait).
function computeTabAgentStatus(id: string): TabAgentStatus {
  const info = tabInfo.get(id)
  if (!info) return 'none'
  // Prune before the isAgentTab early-return: a tab that has left agent mode
  // (back to a plain shell) must still expire its lingering `done` entries,
  // or they would stay in activeAgents indefinitely.
  pruneDoneAgents(info)
  if (!isAgentTab(info)) return 'none'
  if (extractCriticalError(tabLastOutput.get(id) || '')) return 'error'
  const active = Date.now() - (tabLastOutputAt.get(id) ?? 0) < 3000
  if (active) return 'running'
  const hasStarted = info.activeAgents.some((a) => a.status === 'started')
  const hasDone = info.activeAgents.some((a) => a.status === 'done')
  if (hasDone && !hasStarted) return 'done'
  // Waiting-equivalent: promote to 'attention' only when a live (non-stale) select
  // prompt is actually on screen — the same guard that gates the quick-answer chips,
  // so chips appear exactly in the 'attention' state.
  if (!isPromptChoicesStale(id) && extractPromptChoices(tabLastOutput.get(id) || '').length > 0) return 'attention'
  return 'waiting'
}

// Handle a detected [[AGENT: label :: model :: status]] marker from tab `tabId`.
// started → upsert into activeAgents (by label); done → mark the entry done (kept for
// AGENT_DONE_LINGER_MS so the green 完了 state is visible, then pruned lazily).
// Idempotent per state: duplicate started upserts / done marks are harmless, so a
// marker slipping through dedup is safe. Called only from the OSC 777 path
// (the plain-text fallback has been removed).
function handleAgentMarker(tabId: string, label: string, model: string, status: 'started' | 'done') {
  const key = `${label}::${model}::${status}`
  let seen = tabAgentMarkerSeen.get(tabId)
  if (!seen) { seen = new Map(); tabAgentMarkerSeen.set(tabId, seen) }
  const now = Date.now()
  const last = seen.get(key)
  seen.set(key, now) // (re)insert — refreshes sliding TTL and LRU position
  if (seen.size > AGENT_MARKER_DEDUP_MAX_PER_TAB) {
    const oldest = seen.keys().next().value as string
    seen.delete(oldest)
  }
  if (last !== undefined && now - last < AGENT_MARKER_DEDUP_TTL_MS) return

  const info = tabInfo.get(tabId)
  if (!info) return
  // Keep the " (継承)" suffix (hook-resolved inherited parent model) so the
  // popover can distinguish inherited models; the renderer strips it for
  // badge lookup.
  const base = normalizeClaudeModel(model)
  const normalized = base ? (model.includes('継承') ? `${base} (継承)` : base) : model
  if (status === 'started') {
    const existing = info.activeAgents.find((a) => a.label === label)
    if (existing) {
      existing.model = normalized
      existing.status = 'started'
      existing.doneAt = undefined
    } else {
      info.activeAgents.push({ label, model: normalized, status: 'started' })
    }
  } else {
    // Mark done (upsert: a done without a seen started still shows as 完了).
    // The entry lingers for AGENT_DONE_LINGER_MS and is pruned on IPC polls.
    const existing = info.activeAgents.find((a) => a.label === label)
    if (existing) {
      existing.status = 'done'
      existing.doneAt = now
    } else {
      info.activeAgents.push({ label, model: normalized, status: 'done', doneAt: now })
    }
    // Clear the label's `started` dedup records so relaunching the same label
    // right away is not swallowed by the TTL window.
    const prefix = `${label}::`
    for (const k of [...seen.keys()]) {
      if (k.startsWith(prefix) && k.endsWith('::started')) seen.delete(k)
    }
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
  const candidates = tabOrder.filter((id) => id !== switchController.owner(excludeTabId))
  const exact = candidates.filter((id) => (tabInfo.get(switchController.active(id))?.issue || '') === name)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) return null
  const prefix = candidates.filter((id) => {
    const issue = tabInfo.get(switchController.active(id))?.issue || ''
    return issue !== '' && issue.startsWith(name)
  })
  if (prefix.length === 1) return prefix[0]
  return null
}

// A tab counts as "AI agent running" when any agent (Claude/Gemini/Codex) was
// launched in it and its foreground process has not returned to a plain shell.
// SECURITY: SEND delivery must be gated on this — injecting into a plain shell
// would execute the message body as a shell command.
function isAgentTab(info: { proc: string; hadClaude: boolean; hadGemini: boolean; hadCodex: boolean } | undefined): boolean {
  if (!info) return false
  return (info.hadClaude || info.hadGemini || info.hadCodex) && info.proc !== '' && !SHELLS.has(info.proc)
}

// Inject a message into the destination PTY via bracketed paste.
// SECURITY: does NOT auto-submit with \r. Auto-execution here would let a
// prompt-injected [[SEND:]] block in one tab's output silently drive actions
// in another tab with no human in the loop. The pasted text sits in the
// destination's input line; a human watching that tab must press Enter to
// actually run it. The "[from: <fromName>] " prefix makes the message's
// origin visible to that human before they decide to submit.
function deliverAgentMsg(msg: AgentMsg) {
  const proc = ptyProcesses.get(msg.toTabId)
  if (!proc) return
  const text = `[from: ${msg.fromName}] ${msg.body}`
  proc.write('\x1b[200~' + text + '\x1b[201~')
  tabInputBuf.set(msg.toTabId, (tabInputBuf.get(msg.toTabId) || '') + text)
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
  if (switchController.blocked(fromTabId)) return
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
  const logicalDest = resolveTabByName(destName, fromTabId)
  const toTabId = logicalDest ? switchController.active(logicalDest) : null
  if (!toTabId) {
    console.log(`[agent-msg] 宛先が見つからない: "${destName}" (from: ${fromName})`)
    mainWindow?.webContents.send('agent-msg:notify', {
      type: 'error', from: fromName, dest: destName, body,
    })
    return
  }
  // Reject delivery when the destination tab has no AI agent running: bracketed paste
  // into a plain shell would let the message body run as a shell command.
  if (!isAgentTab(tabInfo.get(toTabId))) {
    console.log(`[agent-msg] 宛先タブはAIエージェント未実行のため送信を拒否: "${destName}" (from: ${fromName})`)
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
    if (switchController.blocked(msg.toTabId)) { i++; continue }
    if (!ptyProcesses.has(msg.toTabId)) {
      console.log(`[agent-msg] 宛先タブが閉じられたため破棄: ${msg.toTabId}`)
      agentMsgQueue.splice(i, 1)
      continue
    }
    // Re-check at delivery time (TOCTOU): the destination may have passed the
    // isAgentTab gate at enqueue but returned to a plain shell while queued —
    // delivering then would let the message body run as a shell command.
    if (!isAgentTab(tabInfo.get(msg.toTabId))) {
      const destName = tabInfo.get(msg.toTabId)?.issue || msg.toTabId
      console.log(`[agent-msg] 宛先タブのAIエージェントが待機中に終了したため送信を取り消し: "${destName}" (from: ${msg.fromName})`)
      agentMsgQueue.splice(i, 1)
      mainWindow?.webContents.send('agent-msg:notify', {
        type: 'error', from: msg.fromName, dest: destName, body: msg.body,
      })
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

// --- Selectable prompt choices (quick-answer chips on waiting tabs) ---
// A numbered choice offered by an agent CLI select prompt (e.g. "❯ 1. Yes / 2. No")
interface PromptChoice {
  num: string
  label: string
}

const PROMPT_CHOICES_MAX = 10
// One choice line, after stripping box-drawing borders:
//   [│] [❯] <num>[.)] <label> [│]
// Captures: 1 = box border prefix, 2 = indent before the number, 3 = caret, 4 = number, 5 = label
const PROMPT_CHOICE_LINE_RE = /^(\s*│)?( *)(❯\s*)?(\d{1,2})[.)]\s+(.+?)\s*│?\s*$/

// Extract the numbered choices of a select prompt (e.g. Claude Code's permission
// dialog / AskUserQuestion: "❯ 1. Yes\n  2. No, and tell Claude what to do differently")
// from a tab's raw PTY buffer. Returns [] when no prompt is detected.
//
// False-positive guards (all must hold — plain numbered lists in code/output must NOT match):
// - computeTabAgentStatus only invokes this for tabs that are otherwise 'waiting'
//   (agent tab, > 3 s silent); detection promotes the status to 'attention'
// - each line must carry a ❯ caret or ≥2 spaces of indent before the number
// - numbers must be consecutive starting at 1, block size 2..PROMPT_CHOICES_MAX
// - at least one line in the block must have the ❯ caret (the TUI selection cursor)
// TUI repaints leave the same block in the buffer multiple times → last block wins.
function extractPromptChoices(rawBuffer: string): PromptChoice[] {
  const stripped = rawBuffer
    .replace(/\x1b\][^\x07\x1b]*\x07/g, '')          // OSC sequences (e.g. ]0;title BEL)
    .replace(/\x1b\][^\x1b]*\x1b\\/g, '')             // OSC sequences (ST terminated)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')           // CSI sequences
    .replace(/\x1b[a-zA-Z]/g, '')                     // simple escape sequences
    .replace(/\r/g, '')

  const lines = stripped.split('\n')
  // Parse every line into a choice candidate (or null), preserving line positions
  const parsed = lines.map((line) => {
    const m = line.match(PROMPT_CHOICE_LINE_RE)
    if (!m) return null
    const hasCaret = !!m[3]
    const indented = (m[2] ?? '').length >= 2
    if (!hasCaret && !indented) return null // bare "1. foo" at column 0 → likely a plain list
    const label = m[5].trim()
    if (!label) return null
    return { num: m[4], label, hasCaret }
  })

  // Collect contiguous runs of choice lines, keep the LAST valid block
  let best: PromptChoice[] = []
  let run: { num: string; label: string; hasCaret: boolean }[] = []
  const flush = () => {
    if (run.length >= 2 && run.length <= PROMPT_CHOICES_MAX &&
        run.some((c) => c.hasCaret) &&
        run.every((c, i) => Number(c.num) === i + 1)) {
      best = run.map(({ num, label }) => ({ num, label }))
    }
    run = []
  }
  for (const p of parsed) {
    if (p) run.push(p)
    else flush()
  }
  flush()
  return best
}

// Stale-prompt guard for quick-answer chips: tabLastOutput is a raw tail buffer, so an
// already-answered dialog can linger there (if fewer than the buffer window of output
// followed the answer). If no new PTY output has arrived since the last chip send,
// whatever extractPromptChoices finds is the old, answered prompt — suppress it.
function isPromptChoicesStale(tabId: string): boolean {
  const sentAt = tabInfo.get(tabId)?.lastChoiceSentAt
  if (sentAt === undefined) return false
  return (tabLastOutputAt.get(tabId) ?? 0) <= sentAt
}

// --- Critical error detection (red blinking 'error' tab status) ---
// Patterns that indicate the agent CLI hit an error a human must resolve NOW:
// API failures (rate limit / overloaded) and auth failures (login required,
// expired credentials). Matched per line, case-insensitively, against the
// ANSI-stripped tail buffer. Bare status codes (401/403/429) are deliberately
// NOT matched alone — only next to error context words — since 3-digit numbers
// are everywhere in terminal output (line numbers, byte counts, ...).
const CRITICAL_ERROR_PATTERNS: RegExp[] = [
  // Claude Code TUI: "⎿  API Error: ..." / "API Error (overloaded)" etc.
  /\bAPI\s+Error\b/i,
  /APIエラー/,
  /\brate.?limit(?:ed|s)?\b/i,
  /\boverloaded_error\b/i,
  // Status codes only with adjacent error context: "error ... 429", "429 Too Many Requests"
  /(?:\berror\b|エラー)\D{0,20}\b(?:401|403|429)\b/i,
  /\b(?:401\s+Unauthorized|403\s+Forbidden|429\s+Too\s+Many\s+Requests)\b/i,
  // Auth / login required
  /\bplease\s+run\s+\/login\b/i,
  /\bplease\s+log\s?in\b/i,
  /ログインしてください/,
  /認証(?:エラー|に失敗|が切れ)/,
  /\binvalid\s+api\s+key\b/i,
  /\bre-?authenticate\b/i,
  /\bauthentication[_\s]+(?:error|failed)\b/i,
  /\bOAuth\s+token\s+(?:has\s+)?(?:expired|revoked)\b/i,
]
// Heuristic guard against matching keywords inside *displayed source code*
// (e.g. an agent reading `console.log('API Error handling')` echoes it to the
// terminal). Skips lines that look like code: comment markers, log calls,
// arrow functions, or a trailing string-literal argument. Not airtight — just
// cheap coverage of the common echo shapes.
const CODE_LIKE_LINE_RE = /(?:\/\/|\/\*|\bconsole\.\w+\(|\blogger?\.\w+\(|\bthrow\s+new\b|=>\s|['"`][^'"`]*['"`]\s*[,)];?\s*$)/
// Markdown prose shapes (headings, bullets, numbered lists, quotes): an agent
// documenting error handling echoes these; a TUI error banner never does.
const MARKDOWN_LINE_RE = /^\s*(?:#{1,6}\s|[-*•]\s|\d+[.)]\s|>\s)/
// Diff output (git diff / git log -p): removed lines are rendered red, so a
// deleted line that happens to contain "rate limit" etc. would pass the
// red-SGR tier. Any line starting with the diff marker `-` (or `+`, for
// symmetry) is displayed source, never an error banner — skip it outright.
const DIFF_LINE_RE = /^[+-]/
// Explanatory / hypothetical sentence markers (「〜の場合」, "avoid", "must", ...):
// prose ABOUT errors, not an error itself.
const EXPLANATORY_PROSE_RE = /の場合|する(?:場合|には|とき)|した(?:場合|とき|時)|対処法|対策|については|ようにし|\bavoid\b|\bmust\b|\bshould\b|\bin\s+order\s+to\b|\bif\b|\bwhen\b/i
// A real error banner starts with the error text itself, optionally preceded by
// TUI decoration (⎿, ✗, !) or an "Error:" label — never by a sentence subject
// (「ユーザーは再度ログインしてください」). Applied to the text before the match.
const BANNER_PREFIX_RE = /^(?:[\s⎿✗✘×•·!⚠️[\]()]+|error[:：\s]+|エラー[:：\s]*)*$/i
// Fallback-tier whitelist (no color info): the text at the match must itself be
// a formulaic error banner ("API Error: <reason>", "Please run /login", ...).
// A prefix match alone lets prose that merely *starts* with a keyword through
// (「APIエラーを直して」, "API Errorは発生していませんでした"), so each shape is
// anchored to the exact banner grammar the CLIs emit.
const BANNER_SHAPE_RES: RegExp[] = [
  /^(?:API\s+)?Error\b\s*(?:[:：]\s*|\()\S/i,      // "API Error: reason" / "API Error (429 ...)"
  /^APIエラー(?:[:：]|が発生)/,
  /^rate.?limit(?:ed|s)?(?:\s+(?:exceeded|reached|hit))?\.?$/i,
  /^overloaded_error\b/i,
  /^(?:401\s+Unauthorized|403\s+Forbidden|429\s+Too\s+Many\s+Requests)\b/i,
  /^Please\s+(?:run\s+)?\/?log\s?in\b/i,
  /^Invalid\s+API\s+key\b/i,
  /^(?:再度)?ログインしてください/,
  /^認証(?:エラー|に失敗|が切れ)/,
  /^re-?authenticate\b/i,
  /^authentication[_\s]+(?:error|failed)\b/i,
  /^OAuth\s+token\b/i,
]
// SGR sequences that render red: basic/bright fg+bg (31/91/41/101) and the red
// band of the 256-color palette (1, 9, 52, 88, 124-125, 160-161, 196-204).
const RED_SGR_RE = /\x1b\[(?:[0-9;]*;)?(?:31|91|41|101|[34]8;5;(?:52|88|12[45]|16[01]|19[6-9]|20[0-4]|[19]))(?:;[0-9;]*)?m/
const TRUECOLOR_SGR_RE = /\x1b\[[0-9;]*[34]8;2;(\d{1,3});(\d{1,3});(\d{1,3})/g

// True when a raw (ANSI-included) line carries a red-ish SGR color — the shape
// Claude Code / Gemini / Codex TUIs actually use to render error banners. Prose
// merely *mentioning* errors is never colored red, so this is the strongest
// false-positive filter available.
function lineHasRedAnsi(rawLine: string): boolean {
  if (RED_SGR_RE.test(rawLine)) return true
  TRUECOLOR_SGR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TRUECOLOR_SGR_RE.exec(rawLine))) {
    const r = Number(m[1]), g = Number(m[2]), b = Number(m[3])
    if (r >= 150 && g <= r * 0.6 && b <= r * 0.6) return true
  }
  return false
}

function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*\x07/g, '')          // OSC sequences (e.g. ]0;title BEL)
    .replace(/\x1b\][^\x1b]*\x1b\\/g, '')             // OSC sequences (ST terminated)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')           // CSI sequences
    .replace(/\x1b[a-zA-Z]/g, '')                     // simple escape sequences
}

// True when the tab's recent output contains a critical error banner (API error /
// auth failure). Operates on tabLastOutput, which is already a ~3000-char tail —
// so a stale error naturally scrolls out of detection as new output arrives.
// Two-tier check per line to avoid false positives on prose that merely talks
// about errors ("## APIエラー時の対処法", "please log in again if ..."):
//   1. Primary: the line matches a critical pattern AND is rendered with a red
//      SGR color in the raw buffer.
//   2. Fallback (terminal emitted no color info): only accept short (≤60 chars),
//      banner-shaped lines — not markdown, not explanatory prose, nothing but
//      decoration / an "Error:" label before the matched text, and the matched
//      text itself must fit a formulaic banner shape (BANNER_SHAPE_RES).
// Diff lines (`-`/`+` markers) are excluded before either tier: git renders
// removed lines red, which would otherwise satisfy the primary tier.
function extractCriticalError(rawBuffer: string): boolean {
  for (const rawLine of rawBuffer.split(/\r\n|[\r\n]/)) {
    const line = stripAnsi(rawLine)
    if (DIFF_LINE_RE.test(line)) continue
    if (CODE_LIKE_LINE_RE.test(line)) continue
    let matchIndex = -1
    for (const re of CRITICAL_ERROR_PATTERNS) {
      const m = re.exec(line)
      if (m && (matchIndex === -1 || m.index < matchIndex)) matchIndex = m.index
    }
    if (matchIndex === -1) continue
    if (lineHasRedAnsi(rawLine)) return true
    if (line.trim().length > 60) continue
    if (MARKDOWN_LINE_RE.test(line)) continue
    if (EXPLANATORY_PROSE_RE.test(line)) continue
    if (!BANNER_PREFIX_RE.test(line.slice(0, matchIndex))) continue
    const matchedText = line.slice(matchIndex).trim()
    if (!BANNER_SHAPE_RES.some((re) => re.test(matchedText))) continue
    return true
  }
  return false
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
  codexSessionId: string | null
  // Launch-flag model only (tabInfo.launchModel) — restored as `claude --model X`.
  // The display model is not persisted; the banner re-detects it after restore.
  model: string | null
  handoff?: {
    active: { agent: ResumableAgent; sessionId: string; cwd: string; claudeResumeParentId?: string | null }
    parked: Array<{ agent: ResumableAgent; sessionId: string; cwd: string; claudeResumeParentId?: string | null }>
    context?: unknown
    history?: Array<{ agent: ResumableAgent; text: string }>
  }
}

// schemaVersion 2 (v2.14.4): `model` is the explicit launch flag, not the banner-detected
// display model. Files without schemaVersion are v1 and their `model` is untrusted.
const SESSION_SCHEMA_VERSION = 3

interface SavedSession {
  schemaVersion?: number
  tabs: SavedTab[]
  activeIndex: number
}

type ResumableAgent = 'claude' | 'codex'
type SessionTitleOverrides = Record<string, string>

const IS_DEV = process.env.NODE_ENV === 'development' || !!process.env.VITE_DEV_SERVER_URL
const SESSION_FILE = path.join(app.getPath('userData'), IS_DEV ? 'session-dev.json' : 'session.json')
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json')
const SESSION_TITLE_OVERRIDES_FILE = path.join(app.getPath('userData'), 'session-title-overrides.json')
const claudeSessionTitleCache = new Map<string, { mtime: number; size: number; title: string | null }>()

function cachedClaudeSessionTitle(filePath: string, stat: fs.Stats): string | null {
  const cached = claudeSessionTitleCache.get(filePath)
  if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) return cached.title
  const title = readClaudeSessionTitle(filePath)
  claudeSessionTitleCache.set(filePath, { mtime: stat.mtimeMs, size: stat.size, title })
  return title
}

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
    const info = tabInfo.get(switchController.active(id))
    if (info) {
      const group = switchController.groups.get(id)
      const committedRecovery = group?.recovery as { created?: boolean; runtime?: string } | null | undefined
      const committedMembers = group ? [...group.members].filter(runtime => !(committedRecovery?.created && committedRecovery.runtime === runtime)) : []
      const linked = !!group && !group.pending && (committedMembers.length > 1 || group.parked?.size > 0)
      const exactLineage = linked || !!(group as any)?.committedLineage
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
        if (!claudeSessionId && !exactLineage) {
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
        codexSessionId: info.hadCodex
          ? (isCodexUuid(info.codexSessionId) ? info.codexSessionId : exactLineage ? null : getLastCodexSessionId(info.cwd || HOME))
          : null,
        // Persist the launch flag, not the display model (see tabInfo.launchModel).
        model: info.launchModel,
        handoff: linked && ((info.hadClaude ? info.claudeSessionId || info.claudeResumeParentId : info.codexSessionId)) ? {
          active: { agent: info.hadClaude ? 'claude' : 'codex', sessionId: (info.hadClaude ? info.claudeSessionId || info.claudeResumeParentId : info.codexSessionId)!, cwd: info.cwd || HOME, claudeResumeParentId: info.claudeResumeParentId },
          parked: [
            ...committedMembers.filter(runtime => runtime !== switchController.active(id)).map(runtime => {
              const parked = tabInfo.get(runtime)!; return { agent: parked.hadClaude ? 'claude' as const : 'codex' as const, sessionId: (parked.hadClaude ? parked.claudeSessionId || parked.claudeResumeParentId : parked.codexSessionId) || '', cwd: parked.cwd || HOME, claudeResumeParentId: parked.claudeResumeParentId }
            }).filter(item => !!item.sessionId),
            ...[...group.parked.values()],
          ],
          context: group.context.exportSnapshot(), history: group.history,
        } : undefined,
      })
      // A later in-flight handoff has no committed target yet. Keep the last
      // known-good exact lineage rather than degrading this save to a loose
      // single-session restore (and never persist the pending created runtime).
      const savedTab = tabs[tabs.length - 1]
      if ((group?.pending || group?.recovery || group?.errorCode?.startsWith('saved_') || !linked) && (group as any)?.committedLineage) savedTab.handoff = (group as any).committedLineage
      else if (savedTab.handoff) (group as any).committedLineage = savedTab.handoff
    }
  }
  const session: SavedSession = { schemaVersion: SESSION_SCHEMA_VERSION, tabs: tabs.slice(0, 15), activeIndex: 0 }
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session), 'utf-8')
  } catch { /* ignore */ }
}

function loadSession(): SavedSession | null {
  try {
    const raw = fs.readFileSync(SESSION_FILE, 'utf-8')
    const session = JSON.parse(raw) as SavedSession
    if (session.tabs && session.tabs.length > 0) {
      // One-time migration from v1: `model` there was the banner-detected display model
      // (last-wins), so it cannot be trusted as an explicit user choice. Drop it and let
      // the CLI default (~/.claude/settings.json) apply; the user re-picks via the model
      // chip if they want a pin. The next saveSession() writes v2 with launchModel.
      if ((session.schemaVersion ?? 1) < 2) {
        for (const tab of session.tabs) tab.model = null
      }
      return session
    }
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
        if (info) {
          if (info.pendingSessionTitle) {
            info.claudeSessionId = sessionId
            persistTabSessionTitle(info, info.pendingSessionTitle)
            info.pendingSessionTitle = null
          } else {
            copySessionTitleOverride('claude', info.claudeResumeParentId || info.claudeSessionId, sessionId)
            info.claudeSessionId = sessionId
          }
          tabInfo.set(tabId, info)
        }
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

// --- Codex session helpers ---

// Codex stores rollouts in ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl.
// Unlike claude/gemini, the directory tree is NOT split by cwd — all projects' sessions
// share the same date directory, so every candidate file's first-line
// session_meta.payload.cwd must be checked against the tab's cwd before use.
const CODEX_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CODEX_ROLLOUT_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

interface CodexRolloutInfo {
  cwd: string | null
  preview: string | null
  source: unknown
  originator: string | null
}

const codexRolloutInfoCache = new Map<string, { mtime: number; size: number; info: CodexRolloutInfo }>()
let codexHistoryTitlesCache: { mtime: number; size: number; titles: Map<string, string> } | null = null

// Security guard: only UUID-shaped strings may ever be interpolated into a
// PTY command ("codex resume <id>"). Anything else is rejected.
function isCodexUuid(id: string | null | undefined): id is string {
  return !!id && CODEX_UUID_RE.test(id)
}

function sessionTitleOverrideKey(agent: ResumableAgent, sessionId: string): string {
  return `${agent}:${sessionId.toLowerCase()}`
}

function readSessionTitleOverrides(): SessionTitleOverrides {
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSION_TITLE_OVERRIDES_FILE, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: SessionTitleOverrides = {}
    for (const [key, value] of Object.entries(parsed)) {
      const match = key.match(/^(claude|codex):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)
      if (match && typeof value === 'string' && value.trim()) {
        out[sessionTitleOverrideKey(match[1].toLowerCase() as ResumableAgent, match[2])] = value.trim().slice(0, 120)
      }
    }
    return out
  } catch { return {} }
}

function setSessionTitleOverride(agent: ResumableAgent, sessionId: string, title: string | null): boolean {
  // Both Claude and Codex currently use UUID session IDs. Keep the same strict
  // shape guard used before interpolating Codex IDs into PTY commands.
  if (!isCodexUuid(sessionId)) return false
  const overrides = readSessionTitleOverrides()
  const key = sessionTitleOverrideKey(agent, sessionId)
  const trimmed = typeof title === 'string' ? title.trim().slice(0, 120) : ''
  if (trimmed) overrides[key] = trimmed
  else delete overrides[key]
  try {
    fs.mkdirSync(path.dirname(SESSION_TITLE_OVERRIDES_FILE), { recursive: true })
    const tmp = `${SESSION_TITLE_OVERRIDES_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(overrides, null, 2), 'utf-8')
    fs.renameSync(tmp, SESSION_TITLE_OVERRIDES_FILE)
    return true
  } catch { return false }
}

function copySessionTitleOverride(agent: ResumableAgent, fromSessionId: string | null, toSessionId: string): void {
  if (!isCodexUuid(fromSessionId) || !isCodexUuid(toSessionId) || fromSessionId === toSessionId) return
  const overrides = readSessionTitleOverrides()
  const sourceTitle = overrides[sessionTitleOverrideKey(agent, fromSessionId)]
  const targetKey = sessionTitleOverrideKey(agent, toSessionId)
  if (sourceTitle && !overrides[targetKey]) setSessionTitleOverride(agent, toSessionId, sourceTitle)
}

function persistTabSessionTitle(info: NonNullable<ReturnType<typeof tabInfo.get>>, title: string): boolean {
  let persisted = false
  if (info.hadClaude) {
    // Keep parent and continuation aligned. The parent is the canonical resume
    // checkpoint, while the continuation can still appear in the Resume list.
    const ids = new Set([info.claudeResumeParentId, info.claudeSessionId])
    for (const sessionId of ids) {
      if (isCodexUuid(sessionId)) persisted = setSessionTitleOverride('claude', sessionId, title) || persisted
    }
  }
  if (info.hadCodex && isCodexUuid(info.codexSessionId)) {
    persisted = setSessionTitleOverride('codex', info.codexSessionId, title) || persisted
  }
  return persisted
}

function codexDayDir(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return path.join(HOME, '.codex', 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()))
}

// Read session_meta.payload.cwd from the first line of a rollout file.
// Reads only the head of the file; falls back to a regex extract if the
// first line is longer than the read window or JSON.parse fails.
function readCodexRolloutCwd(filePath: string): string | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(65536)
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0)
    const chunk = buf.toString('utf-8', 0, bytes)
    const nl = chunk.indexOf('\n')
    const firstLine = nl === -1 ? chunk : chunk.slice(0, nl)
    try {
      const meta = JSON.parse(firstLine)
      const cwd = meta?.payload?.cwd ?? meta?.session_meta?.payload?.cwd
      if (typeof cwd === 'string') return cwd
    } catch { /* fall through to regex */ }
    const m = firstLine.match(/"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/)
    if (m) {
      try { return JSON.parse(m[1]) as string } catch { /* ignore */ }
    }
  } catch { /* ignore */ } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* ignore */ } }
  }
  return null
}

// List rollout files in a date dir as { file, dir, uuid, mtime } entries
function listCodexRollouts(dir: string): Array<{ path: string; uuid: string; mtime: number; size: number }> {
  const out: Array<{ path: string; uuid: string; mtime: number; size: number }> = []
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(CODEX_ROLLOUT_RE)
      if (!m) continue
      const full = path.join(dir, f)
      try {
        const stat = fs.statSync(full)
        out.push({ path: full, uuid: m[1], mtime: stat.mtimeMs, size: stat.size })
      }
      catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return out
}

// Read cwd + a preview (first real user message) and source from a rollout file head.
// Bounded read (512KB): the first line holds session_meta.payload.cwd; later
// response_item lines with payload.role === 'user' hold user messages, but the
// first few are injected context (<environment_context>, <user_instructions>,
// AGENTS.md instructions) and must be skipped.
function readCodexRolloutInfo(filePath: string, knownMtime?: number, knownSize?: number): CodexRolloutInfo {
  let mtime = knownMtime
  let size = knownSize
  if (mtime === undefined || size === undefined) {
    try {
      const stat = fs.statSync(filePath)
      mtime = stat.mtimeMs
      size = stat.size
    } catch { /* read below returns empty info */ }
  }
  const cached = codexRolloutInfoCache.get(filePath)
  if (cached && cached.mtime === mtime && cached.size === size) return cached.info

  let fd: number | null = null
  let cwd: string | null = null
  let preview: string | null = null
  let source: unknown = null
  let originator: string | null = null
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(512 * 1024)
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0)
    const chunk = buf.toString('utf-8', 0, bytes)
    const lines = chunk.split('\n')
    // First line: session_meta with cwd
    try {
      const meta = JSON.parse(lines[0])
      const c = meta?.payload?.cwd ?? meta?.session_meta?.payload?.cwd
      if (typeof c === 'string') cwd = c
      source = meta?.payload?.source ?? meta?.session_meta?.payload?.source ?? null
      const o = meta?.payload?.originator ?? meta?.session_meta?.payload?.originator
      if (typeof o === 'string') originator = o
    } catch { /* ignore */ }
    if (cwd === null) {
      const m = (lines[0] ?? '').match(/"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/)
      if (m) { try { cwd = JSON.parse(m[1]) as string } catch { /* ignore */ } }
    }
    // Subsequent lines: first genuine user message
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim()) continue
      let obj: { type?: string; payload?: { type?: string; role?: string; content?: Array<{ type?: string; text?: string }> } }
      try { obj = JSON.parse(line) } catch { continue }
      if (obj?.type !== 'response_item') continue
      const p = obj.payload
      if (p?.type !== 'message' || p?.role !== 'user' || !Array.isArray(p.content)) continue
      const text = p.content
        .filter((c) => typeof c?.text === 'string')
        .map((c) => c.text as string)
        .join('\n')
        .trim()
      if (!text) continue
      // Skip injected context blocks (env context, user instructions, AGENTS.md)
      if (/^(<environment_context|<user_instructions|<permissions|<recommended_plugins|#\s*AGENTS\.md)/i.test(text)) continue
      preview = text.split('\n')[0].slice(0, 120)
      break
    }
  } catch { /* ignore */ } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* ignore */ } }
  }
  const info = { cwd, preview, source, originator }
  if (mtime !== undefined && size !== undefined) codexRolloutInfoCache.set(filePath, { mtime, size, info })
  return info
}

// history.jsonl contains only user-visible Codex threads and records the actual
// submitted prompts without the large injected context found in rollout files.
// Returning null (rather than an empty map) distinguishes a read failure from a
// valid empty history so callers can use the rollout fallback deliberately.
function readCodexHistoryTitles(): Map<string, string> | null {
  try {
    const historyPath = path.join(HOME, '.codex', 'history.jsonl')
    const stat = fs.statSync(historyPath)
    if (codexHistoryTitlesCache?.mtime === stat.mtimeMs && codexHistoryTitlesCache.size === stat.size) {
      return codexHistoryTitlesCache.titles
    }
    const titles = new Map<string, string>()
    const history = fs.readFileSync(historyPath, 'utf-8')
    for (const line of history.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        const sessionId = entry?.session_id
        const text = entry?.text
        if (!isCodexUuid(sessionId) || titles.has(sessionId.toLowerCase()) || typeof text !== 'string') continue
        const title = text.trim().split('\n')[0].trim().slice(0, 120)
        if (title) titles.set(sessionId.toLowerCase(), title)
      } catch { /* skip malformed history lines */ }
    }
    codexHistoryTitlesCache = { mtime: stat.mtimeMs, size: stat.size, titles }
    return titles
  } catch { return null }
}

function isInteractiveCodexRollout(source: unknown, originator: string | null): boolean {
  if (typeof source === 'string') return source === 'cli' || source === 'vscode'
  // Object-valued sources identify subagents/background helpers in current
  // Codex rollouts. For older files with no source, accept known interactive
  // originators as a best-effort fallback.
  if (source && typeof source === 'object') return false
  return !!originator && /^(codex-tui|codex_cli_rs|codex_chatgpt.*remote)$/i.test(originator)
}

// List ALL codex sessions across every date dir under ~/.codex/sessions
// (full recursive year/month/day walk — numeric dir names only). Total volume
// is small (tens of files), so an unbounded walk is fine here, unlike
// getLastCodexSessionId which stays date-limited for its hot path.
function listCodexSessions(cwdFilter?: string | null): Array<{
  id: string; title: string; cwd: string; updatedAt: number; sizeBytes: number
}> {
  const root = path.join(HOME, '.codex', 'sessions')
  const historyTitles = readCodexHistoryTitles()
  const numericDirs = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir).filter((d) => /^\d+$/.test(d)).map((d) => path.join(dir, d))
    } catch { return [] }
  }
  const out: Array<{ id: string; title: string; cwd: string; updatedAt: number; sizeBytes: number }> = []
  for (const yearDir of numericDirs(root)) {
    for (const monthDir of numericDirs(yearDir)) {
      for (const dayDir of numericDirs(monthDir)) {
        for (const entry of listCodexRollouts(dayDir)) {
          if (!isCodexUuid(entry.uuid)) continue
          const { cwd, preview, source, originator } = readCodexRolloutInfo(entry.path, entry.mtime, entry.size)
          if (cwd === null) continue
          if (cwdFilter && cwd !== cwdFilter) continue
          const historyTitle = historyTitles?.get(entry.uuid.toLowerCase())
          // Current Codex marks subagents and guardians with an object-valued
          // source. Reject them even if a future history format references one.
          if (source && typeof source === 'object') continue
          // A history match is the strongest signal for a visible thread. A
          // freshly-created interactive session may not be flushed there yet,
          // so session_meta is the fallback. Object-valued subagent/guardian
          // sources fail that fallback and stay out of Resume.
          if (!historyTitle && !isInteractiveCodexRollout(source, originator)) continue
          out.push({
            id: entry.uuid,
            title: historyTitle || preview || entry.uuid,
            cwd,
            updatedAt: entry.mtime,
            sizeBytes: entry.size,
          })
        }
      }
    }
  }
  return out
}

// Get the most recent codex session UUID whose rollout cwd matches the given cwd.
// Scans the last few date dirs only (no recursive walk of ~/.codex/sessions).
function getLastCodexSessionId(cwd: string): string | null {
  const dirs: string[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
    const dir = codexDayDir(d)
    if (!dirs.includes(dir)) dirs.push(dir)
  }
  const candidates = dirs.flatMap(listCodexRollouts).sort((a, b) => b.mtime - a.mtime)
  // Bound the number of first-line reads to keep this cheap
  for (const c of candidates.slice(0, 50)) {
    if (!isCodexUuid(c.uuid)) continue
    if (readCodexRolloutCwd(c.path) === cwd) return c.uuid
  }
  return null
}

// Watch for a new codex rollout file created after codex starts.
// Watches today's date dir plus the dir from watcher start time (date-rollover
// safety, max 2 dirs). A new file only "confirms" if its first-line cwd matches
// the tab's cwd — other tabs/projects write into the same shared date dir.
function startCodexSessionWatch(tabId: string, cwd: string) {
  const existing = tabCodexSessionWatchers.get(tabId)
  if (existing) { clearInterval(existing); tabCodexSessionWatchers.delete(tabId) }

  const startDir = codexDayDir(new Date())
  const watchDirs = () => {
    const today = codexDayDir(new Date())
    return today === startDir ? [startDir] : [startDir, today]
  }

  const knownFiles = new Set<string>()
  for (const dir of watchDirs()) {
    for (const e of listCodexRollouts(dir)) knownFiles.add(e.path)
  }
  const startTime = Date.now()

  const watcher = setInterval(() => {
    try {
      const newFiles = watchDirs()
        .flatMap(listCodexRollouts)
        .filter((e) => !knownFiles.has(e.path) && e.mtime >= startTime - 500)
        .sort((a, b) => a.mtime - b.mtime)
      for (const e of newFiles) {
        if (!isCodexUuid(e.uuid)) { knownFiles.add(e.path); continue }
        const fileCwd = readCodexRolloutCwd(e.path)
        if (fileCwd === null) continue // first line may not be flushed yet — retry next tick
        if (fileCwd !== cwd) { knownFiles.add(e.path); continue } // another project's session
        const info = tabInfo.get(tabId)
        if (info) {
          const previousSessionId = info.codexSessionId
          info.codexSessionId = e.uuid
          if (info.pendingSessionTitle) {
            persistTabSessionTitle(info, info.pendingSessionTitle)
            info.pendingSessionTitle = null
          } else {
            copySessionTitleOverride('codex', previousSessionId, e.uuid)
          }
          tabInfo.set(tabId, info)
        }
        console.log(`[codex-session] captured ${e.uuid} for ${tabId} (${cwd})`)
        clearInterval(watcher)
        tabCodexSessionWatchers.delete(tabId)
        return
      }
    } catch { /* ignore */ }
  }, 1000)

  tabCodexSessionWatchers.set(tabId, watcher)
  setTimeout(() => {
    const w = tabCodexSessionWatchers.get(tabId)
    if (w === watcher) { clearInterval(watcher); tabCodexSessionWatchers.delete(tabId) }
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
  if (ptyProcesses.get(id) !== ptyProcess) return
  const info = tabInfo.get(id) || { cwd: '', proc: '', issue: '', latestInput: '', claudeSessionId: null as string | null, claudeResumeParentId: null as string | null, hadClaude: false, hadGemini: false, geminiSessionFile: null as string | null, hadCodex: false, codexSessionId: null as string | null, resuming: false, model: null as string | null, launchModel: null as string | null, activeAgents: [] as ActiveAgent[], pendingSessionTitle: null as string | null }
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
        info.launchModel = null
        info.pendingSessionTitle = null
      }
      if (prevProc === 'gemini') {
        info.hadGemini = false
        info.geminiSessionFile = null
      }
      if (prevProc === 'codex') {
        info.hadCodex = false
        info.codexSessionId = null
        info.pendingSessionTitle = null
      }
      info.latestInput = ''
      tabInputBuf.delete(id)
      tabInputUncertain.delete(id)
    }
  }

  // cwd is now updated via OSC 7 escape sequences emitted by the shell hook.
  // No lsof call needed here.
  tabInfo.set(id, info)
}

function spawnPty(cwd?: string, handoff?: { agent: ResumableAgent; prompt: string; sessionId: string | null; token: string; resumeSessionId?: string }, logicalId?: string): { id: string; ptyProcess: ReturnType<typeof pty.spawn> } {
  const id = logicalId || `tab-${++tabCounter}`
  const shell = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : 'zsh')
  const initialCwd = cwd || HOME
  // Spawn as a login shell (like Terminal.app) so ~/.zprofile / ~/.bash_profile
  // are sourced. Without this, PATH set only there (e.g. the codex installer's
  // ~/.local/bin entry) is missing and the CLI appears as "command not found".
  const shellArgs = handoff
    ? ['-lc', `ac_prompt="$AC_HANDOFF_PROMPT"; unset AC_HANDOFF_PROMPT; exec ${handoff.agent === 'claude' ? (handoff.resumeSessionId ? `claude --resume ${handoff.resumeSessionId}` : `claude --session-id ${handoff.sessionId}`) : (handoff.resumeSessionId ? `codex resume ${handoff.resumeSessionId}` : 'codex')} "$ac_prompt"`]
    : ['zsh', 'bash', 'fish', 'sh'].includes(path.basename(shell)) ? ['-l'] : []
  const ptyProcess = pty.spawn(shell, shellArgs, {
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
      if (handoff) env.AC_HANDOFF_PROMPT = handoff.prompt
      return env
    })(),
  })

  ptyProcesses.set(id, ptyProcess)
  tabInfo.set(id, { cwd: initialCwd, proc: '', issue: '', latestInput: '', claudeSessionId: null, claudeResumeParentId: null, hadClaude: false, hadGemini: false, geminiSessionFile: null, hadCodex: false, codexSessionId: null, resuming: false, model: null, launchModel: null, activeAgents: [], pendingSessionTitle: null })
  if (!handoff) tabOrder.push(id)
  else {
    const info = tabInfo.get(id)!
    info.hadClaude = handoff.agent === 'claude'
    info.hadCodex = handoff.agent === 'codex'
    info.claudeSessionId = handoff.agent === 'claude' ? handoff.sessionId : null
    info.claudeResumeParentId = handoff.agent === 'claude' && handoff.resumeSessionId ? handoff.resumeSessionId : null
    info.codexSessionId = handoff.agent === 'codex' ? handoff.resumeSessionId ?? null : null
    info.proc = handoff.agent
    handoffRuntimes.set(id, { agent: handoff.agent, token: handoff.token, startedAt: Date.now(), exited: false, output: '', transcriptSeen: false,
      initialReceipt: handoff.resumeSessionId ? { prompt: handoff.prompt, token: handoff.token, startedAt: Date.now() } : undefined })
    // Startup transcript echo must never route SEND markers into another tab.
    tabResumeCooldown.set(id, Number.POSITIVE_INFINITY)
    ptyProcess.onExit(() => { const runtime = handoffRuntimes.get(id); if (runtime) runtime.exited = true })
  }

  // Inject shell hook to emit OSC 7 on every prompt (cwd tracking without lsof).
  // OSC 7 format: \033]7;file://hostname/cwd\007
  // We wait a tick so the shell is ready to accept input.
  if (!handoff) setTimeout(() => {
    if (ptyProcesses.get(id) !== ptyProcess) return
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
    if (ptyProcesses.get(id) !== ptyProcess) return
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
    // Detect OSC 777 AGENT markers on the RAW stream, before any ANSI/OSC stripping
    // (Claude Code hooks send [[AGENT:]] markers mechanically inside an OSC 777 envelope;
    //  the stripped-buffer detectors below never see it because OSC strip removes it whole).
    {
      const overlap = tabAgentOscBuf.get(id) || ''
      const raw = overlap + data
      let lastMatchEnd = 0
      for (const m of raw.matchAll(AGENT_OSC_RE)) {
        const inner = new RegExp(AGENT_MARKER_RE.source).exec(m[1])
        if (inner) {
          const label = inner[1].trim()
          const model = inner[2].trim()
          if (label && model) handleAgentMarker(id, label, model, inner[3] as 'started' | 'done')
        }
        lastMatchEnd = m.index! + m[0].length
      }
      // Keep only the unmatched tail so an OSC split across chunks still assembles
      tabAgentOscBuf.set(id, raw.slice(Math.max(lastMatchEnd, raw.length - 500)))
    }

    // Recolor "Stop hook error ..." lines to dim gray before they reach xterm.js.
    // Claude Code's actual notification text is "Stop hook error occurred · ctrl+o to
    // see" (no colon after "error" — verified against the installed CLI binary via
    // `strings`; there is no "Stop hook error:" string anywhere in it). An earlier
    // version of this rewrite matched literal "Stop hook error:" and therefore never
    // matched anything, silently leaving the line in its original color. We now match
    // on the "Stop hook error" prefix alone (no trailing colon assumed) and rewrite
    // only the matched span to explicit ANSI 90 (bright black/gray), resetting the
    // foreground back to default (39) right after — any SGR codes appearing before or
    // after the match (already applied by Claude Code) are left untouched, so a reset
    // code that follows still terminates whatever attributes were active. The match stops
    // at the next \x1b so we never swallow a subsequent escape sequence into the rewrite.
    // Best-effort only: if the line is split across two onData chunks (rare — PTY writes
    // are usually flushed as one line for a single console.error call), the half that
    // arrived in an earlier chunk keeps its original color. That's a cosmetic miss, not a
    // functional break.
    const dataForRenderer = data.includes('Stop hook error')
      ? data.replace(/Stop hook error[^\n\r\x1b]*/g, (m) => `\x1b[90m${m}\x1b[39m`)
      : data

    handoffScreens.set(id, ((handoffScreens.get(id) || '') + dataForRenderer).slice(-131072))
    const runtime = handoffRuntimes.get(id)
    if (runtime) runtime.output = (runtime.output + dataForRenderer).slice(-131072)
    const owner = switchController.owner(id)
    if (switchController.active(owner) === id) mainWindow?.webContents.send('terminal:data', owner, dataForRenderer)
    const prev = tabLastOutput.get(id) || ''
    const combined = (prev + data).slice(-3000)
    tabLastOutput.set(id, combined)
    tabLastOutputAt.set(id, Date.now())

    // Detect the Claude Code startup-banner model line (e.g. "Sonnet 5 with medium effort · Claude Max").
    // Runs outside the resume cooldown on purpose: resume replay repaints the
    // banner too, and we want the badge to follow it. Same chunk-buffer/ANSI-strip scheme
    // as the [[SEND:]] detector; repaint duplicates are harmless (idempotent overwrite).
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
        // Display-only: updates `info.model` (badge). Deliberately does NOT touch
        // `info.launchModel` — the banner reflects whatever model claude picked
        // (settings.json default included), not an explicit user choice, so it must
        // never be persisted as a `--model` launch flag.
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
          // and the explicit launch flag is gone too.
          info.model = null
          info.launchModel = null
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

    // Detect [[SEND:]] patterns — skip during resume replay cooldown
    const cooldownEnd = tabResumeCooldown.get(id) ?? 0
    if (Date.now() > cooldownEnd) {
      const overlap = tabDetectScanBuf.get(id) || ''
      const scanBuf = overlap + data
      const stripped = scanBuf.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '')
      let lastMatchEnd = 0
      // Detect [[SEND: dest :: body]] pattern — agent-to-agent message routing
      for (const match of stripped.matchAll(/\[\[SEND:\s*([^\]:]+?)\s*::\s*([\s\S]+?)\]\]/g)) {
        const dest = match[1].trim()
        const body = match[2].trim()
        if (dest && body) handleAgentSend(id, dest, body)
        lastMatchEnd = Math.max(lastMatchEnd, match.index! + match[0].length)
      }
      // [[AGENT:]] markers are NOT detected on this plain-text stream: only the OSC 777
      // hook envelope above is trusted. A plain-text fallback used to live here (legacy
      // from before the hook existed) but it let external content echoed on the PTY
      // (cat'ed files, curl output) forge agent badges, so it was removed.
      // Keep only the unmatched tail for split-chunk detection
      // (500 chars: [[SEND:]] bodies can be long and split across chunks)
      tabDetectScanBuf.set(id, stripped.slice(Math.max(lastMatchEnd, stripped.length - 500)))
    }
  })

  // Poll process name + cwd
  const timer = setInterval(() => updateTabInfo(id, ptyProcess), 1500)
  tabTimers.set(id, timer)

  // Initial update
  setTimeout(() => updateTabInfo(id, ptyProcess), 500)

  return { id, ptyProcess }
}

// The public tab ID stays stable. Parked runtimes are omitted from tabOrder and
// cannot receive user input or queued agent messages until explicitly activated.
const handoffRuntimes = new Map<string, { agent: ResumableAgent; token: string; startedAt: number; exited: boolean; output: string; transcriptSeen: boolean; initialReceipt?: { prompt: string; token: string; startedAt: number } }>()
const handoffScreens = new Map<string, string>()

type HandoffMetric = {
  from: ResumableAgent | null; to: ResumableAgent; mode: 'new' | 'reuse'
  outcome: 'success' | 'cancelled' | 'failed'; errorCode: string | null; startedAt: number
  durations: { readMs: number; startMs: number; waitMs: number; activateMs: number; totalMs: number; rendererMs?: number }
}
const handoffMetrics: HandoffMetric[] = []
let handoffMetricsLoaded = false
const handoffRenderWait = new Map<string, { token: string; activatedAt: number; rendererMs?: number; metric?: HandoffMetric }>()
function loadHandoffMetrics() {
  if (handoffMetricsLoaded) return
  handoffMetricsLoaded = true
  try {
    const file = path.join(app.getPath('userData'), 'handoff-metrics.json')
    if (fs.statSync(file).size > 256 * 1024) return
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(saved)) return
    for (const value of saved.slice(-100)) {
      if (!value || !['claude', 'codex'].includes(value.to) || !['new', 'reuse'].includes(value.mode) ||
          !['success', 'cancelled', 'failed'].includes(value.outcome) || !Number.isFinite(value.startedAt)) continue
      const durations: HandoffMetric['durations'] = { readMs: 0, startMs: 0, waitMs: 0, activateMs: 0, totalMs: 0 }
      for (const key of ['readMs', 'startMs', 'waitMs', 'activateMs', 'totalMs', 'rendererMs'] as const) {
        if (Number.isFinite(value.durations?.[key]) && value.durations[key] >= 0) durations[key] = value.durations[key]
      }
      handoffMetrics.push({ from: ['claude', 'codex'].includes(value.from) ? value.from : null, to: value.to,
        mode: value.mode, outcome: value.outcome, errorCode: typeof value.errorCode === 'string' && /^[a-z_]{1,50}$/.test(value.errorCode) ? value.errorCode : null,
        startedAt: value.startedAt, durations })
    }
  } catch { /* measurement history is optional */ }
}
function saveHandoffMetrics() {
  try {
    const file = path.join(app.getPath('userData'), 'handoff-metrics.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file + '.tmp', JSON.stringify(handoffMetrics.slice(-100)))
    fs.renameSync(file + '.tmp', file)
  } catch { /* failed measurement storage must not block a handoff */ }
}
function recordHandoffMetric(metric: HandoffMetric, logicalId: string) {
  loadHandoffMetrics()
  const saved = { ...metric, durations: { ...metric.durations } }
  handoffMetrics.push(saved)
  if (handoffMetrics.length > 100) handoffMetrics.shift()
  const render = handoffRenderWait.get(logicalId)
  if (saved.outcome === 'success' && render) {
    render.metric = saved
    if (render.rendererMs !== undefined) saved.durations.rendererMs = render.rendererMs
  }
  saveHandoffMetrics()
}

async function preflightHandoff(agent: ResumableAgent, cwd: string) {
  const loginShell = process.env.SHELL || '/bin/zsh'
  if (!['zsh', 'bash'].includes(path.basename(loginShell))) {
    throw Object.assign(new Error('切り替えはzsh/bashに対応しています。シェル設定を確認してください。'), { code: 'unsupported_shell' })
  }
  await new Promise<void>((resolve, reject) => {
    execFile(loginShell, ['-lc', 'command -v "$1" >/dev/null', 'ac-handoff-check', agent],
      { cwd, timeout: 5000, maxBuffer: 65536, env: { ...process.env, CLAUDECODE: '' } }, (error) => {
        if (!error) return resolve()
        const missing = error.code === 1
        reject(Object.assign(new Error(missing
          ? `${agent === 'claude' ? 'Claude' : 'Codex'}のCLIが見つかりません。導入とログインシェルのPATHを確認して再試行してください。`
          : '切り替え先の起動確認ができませんでした。シェル設定と作業フォルダを確認してください。'), { code: missing ? 'cli_missing' : 'startup_check_failed' }))
      })
  })
}


function trackDraftInput(tabId: string, data: string) {
  const parsed = data.replace(/\x1b\[20[01]~/g, '')
  if (parsed.includes('\r')) {
    tabInputBuf.set(tabId, '')
    tabInputUncertain.delete(tabId)
    return
  }
  if (data === '\x03') {
    tabInputBuf.set(tabId, '')
    tabInputUncertain.delete(tabId)
  } else if (/\x1b(?:\[[0-9;]*[ABCDHF~]|[bfpn])/.test(parsed) || /[\x01\x04\x05\x09\x0e\x10\x12]/.test(parsed)) {
    // History, completion and cursor editing can change text we cannot read
    // back from the TUI. Fail closed until submission or explicit cancellation.
    tabInputUncertain.set(tabId, true)
  } else if (!parsed.startsWith('\x1b')) {
    let buffer = Array.from(tabInputBuf.get(tabId) || '')
    for (const char of parsed) {
      if (char === '\x7f' || char === '\b') buffer.pop()
      else if (char === '\x15' && !tabInputUncertain.get(tabId)) buffer = []
      else if (char.codePointAt(0)! >= 32 || char === '\n') buffer.push(char)
    }
    tabInputBuf.set(tabId, buffer.join(''))
  }
}

function recoveryRuntime(tabId: string) {
  if (!tabOrder.includes(tabId)) return null
  const id = switchController.recoveryRuntime(tabId)
  return id && id !== switchController.active(tabId) ? id : null
}


function releaseHandoffRuntime(id: string) {
  for (const timers of [tabTimers, tabSessionWatchers, tabCodexSessionWatchers, tabGeminiSessionWatchers]) {
    const timer = timers.get(id)
    if (timer) clearInterval(timer)
    timers.delete(id)
  }
  const resumeTimer = tabResumeWatch.get(id)
  if (resumeTimer) clearTimeout(resumeTimer)
  tabResumeWatch.delete(id)
  const proc = ptyProcesses.get(id)
  ptyProcesses.delete(id)
  try { proc?.kill() } catch { /* already exited */ }
  for (const map of [tabInfo, tabInputBuf, tabInputUncertain, handoffRenderWait, tabLastOutput, tabLastOutputAt, tabLastInputAt,
    tabDetectScanBuf, tabModelScanBuf, tabSentAgentMsgKeys, tabAgentMarkerSeen,
    tabAgentOscBuf, tabResumeCooldown, handoffRuntimes, handoffScreens]) map.delete(id)
  for (let i = agentMsgQueue.length - 1; i >= 0; i--) {
    if (agentMsgQueue[i].toTabId === id || agentMsgQueue[i].fromTabId === id) agentMsgQueue.splice(i, 1)
  }
}

async function readRuntimeHandoff(id: string) {
  const info = tabInfo.get(id)
  const runtime = handoffRuntimes.get(id)
  const agent = runtime?.agent ?? (info?.hadClaude ? 'claude' : info?.hadCodex ? 'codex' : null)
  const unavailable = (reason: string) => ({ agent, ready: false, reason, cwd: info?.cwd || HOME, lastEventAt: 0, lastAssistantText: '', text: '' })
  if (!info || !agent || !isAgentTab(info) || runtime?.exited) return unavailable('ClaudeまたはCodexの会話を開始してください。')
  if (tabInputUncertain.get(id)) return unavailable('編集中の入力を確認できません。送信するか、Ctrl+Cで入力を取り消してから切り替えてください。')
  if (tabInputBuf.get(id)?.trim()) return unavailable('入力中の文章を送信、または消してから切り替えてください。')
  if (info.activeAgents.some(a => a.status === 'started')) return unavailable('実行中のエージェントの完了を待っています。')
  let sessionId = agent === 'claude' ? info.claudeSessionId || info.claudeResumeParentId : info.codexSessionId
  // Codex does not expose a launch --session-id. Bind only a rollout containing
  // our unpredictable handoff nonce, never the most recent file in a shared cwd.
  if (!sessionId && runtime?.agent === 'codex') {
    const dirs = new Set([codexDayDir(new Date(runtime.startedAt)), codexDayDir(new Date())])
    const matches: string[] = []
    for (const candidate of [...dirs].flatMap(listCodexRollouts).filter(e => e.mtime >= runtime.startedAt).slice(0, 50)) {
      if (candidate.size > 8 * 1024 * 1024 || readCodexRolloutCwd(candidate.path) !== info.cwd) continue
      const transcript = await readHandoffSession({ agent, sessionId: candidate.uuid, cwd: info.cwd, home: HOME })
      if (transcript.text.includes(`AC_HANDOFF_READY:${runtime.token}`)) matches.push(candidate.uuid)
    }
    if (matches.length === 1) info.codexSessionId = sessionId = matches[0]
  }
  if (!sessionId) return unavailable('このタブの会話IDを確認しています。')
  // Refuse duplicate ownership rather than risk handing another tab's work over.
  for (const [otherId, other] of tabInfo) {
    if (otherId !== id && (agent === 'claude' ? other.claudeSessionId === sessionId : other.codexSessionId === sessionId)) {
      return unavailable('会話IDが別のタブと重複しています。切り替えを中止しました。')
    }
  }
  const result = await readHandoffSession({ agent, sessionId, cwd: info.cwd, home: HOME })
  if (runtime && result.text) runtime.transcriptSeen = true
  if (runtime?.initialReceipt) {
    const receipt = runtime.initialReceipt
    const exactAck = result.lastAssistantText?.split(/\r?\n/).some(line => line.trim() === `AC_HANDOFF_READY:${receipt.token}`)
    const group = switchController.groups.get(switchController.owner(id))
    group?.context.registerReceipt(result, receipt.prompt, receipt.token)
    if (!result.ready || result.lastEventAt < receipt.startedAt || !exactAck) {
      return { ...result, cwd: info.cwd, ready: false, errorCode: undefined,
        reason: '復元した会話の起動と引き継ぎ確認を待っています。初回設定が表示された場合は完了してください。' }
    }
    group?.context.merge(result)
    delete runtime.initialReceipt
  }
  const ready = result.ready && result.lastEventAt >= (tabLastInputAt.get(id) || 0)
  const unsupported = /malformed|unrecognized|invalid session|metadata|ambiguous|subagent|escapes|exceeds|limit reached/.test(result.reason)
  return { ...result, cwd: info.cwd, ready, errorCode: unsupported ? 'transcript_unsupported' : undefined,
    reason: ready ? '' : unsupported ? '会話ログの形式・識別情報・サイズを確認できません。対応するCLIと会話を確認してください。'
      : '会話の完了を確認しています。処理が終わっても続く場合は会話ログを確認してください。' }

}

const switchController = new AgentSwitchController({
  read: readRuntimeHandoff,
  preflight: preflightHandoff,
  status: (id: string) => {
    const runtime = handoffRuntimes.get(id)
    const info = tabInfo.get(id)
    const agent = runtime?.agent ?? (info?.hadClaude ? 'claude' : 'codex')
    let processStarted = false
    try { processStarted = path.basename(ptyProcesses.get(id)?.process || '').toLowerCase().includes(agent) } catch { /* process may be exiting */ }
    return { started: !!runtime?.transcriptSeen || processStarted }
  },
  recordMetric: recordHandoffMetric,
  token: () => randomUUID(),
  prompt: (source: any, token: string) => buildHandoffPrompt({ source, token })
    // Control characters are never forwarded through a terminal paste.
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''),
  create: (agent: ResumableAgent, cwd: string, prompt: string, token: string) => {
    // zsh/bash are the shell dialects supported by the quoted launch wrapper.
    if (!['zsh', 'bash'].includes(path.basename(process.env.SHELL || 'zsh'))) throw new Error('試作版の切り替えはzsh/bashに対応しています。')
    const { id } = spawnPty(cwd, { agent, prompt, token, sessionId: agent === 'claude' ? randomUUID() : null })
    return id
  },
  send: async (id: string, prompt: string) => {
    const check = await readRuntimeHandoff(id)
    const proc = ptyProcesses.get(id)
    if (!check.ready || !proc) throw new Error('復帰先の会話が入力待ちではありません。')
    tabResumeCooldown.set(id, Number.POSITIVE_INFINITY)
    // This is a user-requested context-receipt turn, not SEND message delivery.
    // No timer guesses about CLI startup: only a verified completed turn reaches here.
    // Keep the user's receipt request outside the CLI's untrusted pasted-content
    // envelope. Only the transcript is pasted; no transcript text is typed as a
    // terminal command or interpreted as a new user instruction.
    const boundary = prompt.indexOf('\n\n')
    if (boundary < 0) throw new Error('引き継ぎ形式を確認できません。')
    if (check.agent === 'claude') proc.write(prompt.slice(0, boundary) + ' ' + '\x1b[200~' + prompt.slice(boundary + 2) + '\x1b[201~\r')
    // Codex's fast-paste handling can drop preceding typed text. It does not
    // wrap the full paste as an untrusted directive, so keep its message whole.
    else proc.write('\x1b[200~' + prompt + '\x1b[201~\r')
    tabLastInputAt.set(id, Date.now())
  },
  activate: (logicalId: string, runtimeId: string) => {
    const original = tabInfo.get(logicalId)
    const current = tabInfo.get(runtimeId)
    if (original && current) current.issue = original.issue
    for (const message of agentMsgQueue) {
      if (switchController.owner(message.toTabId) === logicalId) message.toTabId = runtimeId
    }
    const renderToken = randomUUID()
    handoffRenderWait.set(logicalId, { token: renderToken, activatedAt: Date.now() })
    mainWindow?.webContents.send('terminal:reset', logicalId, handoffScreens.get(runtimeId) || '', renderToken)
    saveSession()
  },
  exited: (id: string) => !ptyProcesses.has(id) || handoffRuntimes.get(id)?.exited === true,
  release: releaseHandoffRuntime,
  restoreParked: async (_logicalId: string, descriptor: { agent: ResumableAgent; sessionId: string; cwd: string; claudeResumeParentId?: string | null }, prompt: string, token: string) => {
    if (!isCodexUuid(descriptor.sessionId)) return { errorCode: 'parked_session_unavailable', reason: '保存された待機会話IDが無効です。' }
    const verified = await readHandoffSession({ agent: descriptor.agent, sessionId: descriptor.sessionId, cwd: descriptor.cwd, home: HOME })
    if (!verified.ready) return { errorCode: 'parked_session_unavailable', reason: '保存された待機会話が見つからないか、完了状態ではありません。' }
    await preflightHandoff(descriptor.agent, descriptor.cwd)
    const { id } = spawnPty(descriptor.cwd, { agent: descriptor.agent, prompt, token, sessionId: descriptor.agent === 'claude' ? descriptor.sessionId : null, resumeSessionId: descriptor.sessionId })
    const info = tabInfo.get(id)!; info.claudeResumeParentId = descriptor.claudeResumeParentId ?? (descriptor.agent === 'claude' ? descriptor.sessionId : null)
    return { runtime: id }
  },
})


function draftDestinationToken(tabId: string) {
  return `${switchController.active(tabId)}:${switchController.groups.get(tabId)?.lastAttempt?.startedAt ?? 0}:${tabLastInputAt.get(switchController.active(tabId)) ?? 0}`
}
async function draftDestination(tabId: string) {
  const runtime = switchController.active(tabId)
  if (!tabOrder.includes(tabId)) return { ready: false, agent: null, token: '', reason: 'タブが見つかりません。' }
  const observedToken = draftDestinationToken(tabId)
  const result = await readRuntimeHandoff(runtime)
  return { ready: observedToken === draftDestinationToken(tabId) && result.ready && !switchController.blocked(runtime) && runtime === switchController.active(tabId), agent: result.agent,
    token: draftDestinationToken(tabId), reason: result.reason }
}
const handoffDrafts = new HandoffDrafts({
  destination: draftDestination,
  write: (tabId: string, destination: string, text: string, submit: boolean) => {
    const runtime = switchController.active(tabId), proc = ptyProcesses.get(runtime)
    let foreground = ''
    try { foreground = path.basename(proc?.process || '').toLowerCase() } catch { /* exited */ }
    if (!tabOrder.includes(tabId) || !proc || !foreground || SHELLS.has(foreground) || !isAgentTab(tabInfo.get(runtime)) || switchController.blocked(runtime) || destination !== draftDestinationToken(tabId)
      || tabInputUncertain.get(runtime) || tabInputBuf.get(runtime)?.trim() || handoffRuntimes.get(runtime)?.exited) throw new Error('送信先が入力待ちではありません。下書きは保持しています。')
    tabResumeCooldown.set(runtime, Number.POSITIVE_INFINITY)
    proc.write('\x1b[200~' + text + '\x1b[201~' + (submit ? '\r' : ''))
    if (submit) tabLastInputAt.set(runtime, Date.now())
    else trackDraftInput(runtime, text)
  },
})

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: 'Agent Conductor',
    titleBarStyle: 'hiddenInset',
    // Vertically centered against the fixed tab bar (--titlebar-height: 40px)
    trafficLightPosition: { x: 12, y: 14 },
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

  ipcMain.handle('terminal:handoff-draft', (_event, tabId: string) => handoffDrafts.get(tabId))
  ipcMain.handle('terminal:set-handoff-draft', (_event, tabId: string, text: string) => {
    if (!tabOrder.includes(tabId)) throw new Error('タブが見つかりません。')
    return handoffDrafts.set(tabId, text)
  })
  ipcMain.handle('terminal:handoff-draft-destination', (_event, tabId: string) => draftDestination(tabId))
  ipcMain.handle('terminal:submit-handoff-draft', (_event, tabId: string, revision: number, destination: string, submit = true) => handoffDrafts.submit(tabId, revision, destination, submit))
  ipcMain.handle('terminal:agent-switch-state', (_event, tabId: string) => switchController.state(tabId))
  ipcMain.handle('terminal:agent-switch-context', (_event, tabId: string) => switchController.preview(tabId))
  ipcMain.handle('terminal:switch-agent', async (_event, tabId: string, target: ResumableAgent) => {
    if (!tabOrder.includes(tabId)) return { ok: false, error: 'タブが見つかりません。' }
    if (handoffDrafts.busy(tabId)) return { ok: false, error: '下書きを送信中です。' }
    try { return await switchController.switch(tabId, target) }
    catch { return { ok: false, error: '引き継ぎ情報を読み取れませんでした。元の作業を維持しています。' } }
  })
  ipcMain.handle('terminal:cancel-agent-switch', (_event, tabId: string) => switchController.cancel(tabId))
  ipcMain.handle('terminal:restore-handoff-session', async (_event, tabId: string, lineage: SavedTab['handoff']) => {
    if (!tabOrder.includes(tabId)) return { ok: false, errorCode: 'saved_session_unavailable', reason: '復元先のタブが見つかりません。' }
    const priorInfo = tabInfo.get(tabId)
    if (!priorInfo || isAgentTab(priorInfo) || switchController.groups.get(tabId)?.pending || tabLastInputAt.has(tabId) || tabInputBuf.get(tabId)?.trim()) return { ok: false, errorCode: 'saved_session_unavailable', reason: '復元先の端末は既に使われています。' }
    const restoreGroup = switchController.group(tabId)
    ;(restoreGroup as any).committedLineage = lineage && JSON.stringify(lineage).length <= 1500000 ? lineage : { active: { agent: 'invalid', sessionId: 'invalid', cwd: priorInfo.cwd }, parked: [], history: [], context: { invalid: true } }
    const fail = (errorCode: string, reason: string) => { restoreGroup.errorCode = errorCode; restoreGroup.error = reason; return { ok: false, errorCode, reason } }

    if (!tabOrder.includes(tabId) || !lineage?.active || !['claude', 'codex'].includes(lineage.active.agent) || !isCodexUuid(lineage.active.sessionId) || typeof lineage.active.cwd !== 'string' || lineage.active.cwd !== priorInfo.cwd) return fail('saved_session_unavailable', '保存された引き継ぎ情報が無効です。')
    // Keep exact linkage on failure too; a subsequent save must never degrade
    // a missing conversation into the legacy most-recent-session fallback.
    ;(restoreGroup as any).committedLineage = JSON.stringify(lineage).length <= 1500000 ? lineage : { active: lineage.active, parked: [], history: [], context: { invalid: true } }
    const verified = await readHandoffSession({ agent: lineage.active.agent, sessionId: lineage.active.sessionId, cwd: lineage.active.cwd, home: HOME })
    if (!verified.ready) return fail('saved_session_unavailable', '保存された会話が見つからないか、完了状態ではありません。')
    try { await preflightHandoff(lineage.active.agent, lineage.active.cwd) }
    catch (error) { return fail('saved_session_unavailable', error instanceof Error ? error.message : '復元先のCLIを起動できません。') }
    if (Array.isArray(lineage.parked) && lineage.parked.some(item => !item || item.agent === lineage.active!.agent || item.cwd !== lineage.active!.cwd)) return fail('saved_session_unavailable', '保存された待機会話の関連付けが無効です。')
    const info = tabInfo.get(tabId); const proc = ptyProcesses.get(tabId)
    if (!info || !proc || isAgentTab(info) || switchController.groups.get(tabId)?.pending || tabLastInputAt.has(tabId) || tabInputBuf.get(tabId)?.trim()) return fail('saved_session_unavailable', '復元先の端末を安全に置き換えられません。')
    if (!switchController.restoreLineage(tabId, lineage)) return fail('saved_context_unavailable', '保存された引き継ぎコンテキストが破損しているため復元を中止しました。')
    const group = switchController.groups.get(tabId)!
    const source = { ...verified, text: group.context.merge(verified).text }
    const token = randomUUID()
    const prompt = buildHandoffPrompt({ source, token }).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    // The initial blank shell has not received user input. Replace it under the
    // same public ID, so stale shell output cannot race a persisted transcript.
    releaseHandoffRuntime(tabId)
    spawnPty(lineage.active.cwd, { agent: lineage.active.agent, prompt, token,
      sessionId: lineage.active.agent === 'claude' ? lineage.active.sessionId : null,
      resumeSessionId: lineage.active.sessionId }, tabId)
    const resumedInfo = tabInfo.get(tabId)!
    resumedInfo.issue = info.issue
    resumedInfo.launchModel = info.launchModel
    ;(group as any).committedLineage = lineage
    group.error = ''; group.errorCode = null
    return { ok: true, pending: true }
  })
  ipcMain.handle('terminal:agent-switch-recovery', (_event, tabId: string) => {
    const id = recoveryRuntime(tabId)
    if (!id) return null
    const runtime = handoffRuntimes.get(id)
    const info = tabInfo.get(id)
    return { agent: runtime?.agent ?? (info?.hadClaude ? 'claude' : 'codex'),
      exited: !ptyProcesses.has(id) || runtime?.exited === true, output: handoffScreens.get(id) || '' }
  })
  ipcMain.handle('terminal:agent-switch-recovery-input', (_event, tabId: string, data: string) => {
    const id = recoveryRuntime(tabId)
    if (!id || typeof data !== 'string' || data.length > 65536 || handoffRuntimes.get(id)?.exited) return false
    const proc = ptyProcesses.get(id)
    if (!proc) return false
    // Explicit setup interaction only; ordinary SEND/input routing stays blocked.
    trackDraftInput(id, data)
    if (data.includes('\r')) tabLastInputAt.set(id, Date.now())
    proc.write(data)
    return true
  })
  ipcMain.handle('terminal:agent-switch-recovery-resize', (_event, tabId: string, cols: number, rows: number) => {
    const id = recoveryRuntime(tabId)
    if (!id || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 500 || rows > 300) return false
    const proc = ptyProcesses.get(id)
    if (!proc) return false
    try { proc.resize(cols, rows); return true } catch { return false }
  })
  ipcMain.handle('terminal:agent-switch-metrics', () => { loadHandoffMetrics(); return handoffMetrics })
  ipcMain.on('terminal:agent-switch-rendered', (_event, tabId: string, token: string) => {
    const pending = handoffRenderWait.get(tabId)
    if (!pending || pending.token !== token || pending.rendererMs !== undefined) return
    pending.rendererMs = Math.max(0, Date.now() - pending.activatedAt)
    if (pending.metric) { pending.metric.durations.rendererMs = pending.rendererMs; saveHandoffMetrics() }
  })



  // Create a new terminal tab (optional cwd)
  // pendingSessionId pre-marks a Resume-created tab with its agent/session so
  // title sync and saveSession() work even before the CLI process starts.
  ipcMain.handle('terminal:create', (_event, cwd?: string, pendingSessionId?: string, pendingAgent: ResumableAgent = 'claude') => {
    const { id } = spawnPty(cwd)
    if (pendingSessionId) {
      const info = tabInfo.get(id)!
      if (pendingAgent === 'codex' && isCodexUuid(pendingSessionId)) {
        info.hadCodex = true
        info.codexSessionId = pendingSessionId
      } else {
        info.hadClaude = true
        info.claudeResumeParentId = pendingSessionId
      }
      info.resuming = true
      tabInfo.set(id, info)
    }
    return id
  })

  // Get title for a tab (poll from renderer)
  ipcMain.handle('terminal:get-title', (_event, tabId: string) => {
    tabId = switchController.active(tabId)
    const info = tabInfo.get(tabId)
    if (!info) return { issue: '', detail: 'Terminal', model: null, activeAgents: [], agentStatus: 'none' as TabAgentStatus, promptChoices: [] as PromptChoice[] }
    const agentStatus = computeTabAgentStatus(tabId) // also prunes expired done entries
    // Quick-answer chips: only scan the buffer for select-prompt choices while waiting for input
    // 'attention' already implies non-stale detected choices (computeTabAgentStatus)
    const promptChoices = agentStatus === 'attention' ? extractPromptChoices(tabLastOutput.get(tabId) || '') : []
    const result: { issue: string; detail: string; model: string | null; activeAgents: ActiveAgent[]; agentStatus: TabAgentStatus; promptChoices: PromptChoice[] } = { ...getTabTitle(info), model: info.model, activeAgents: info.activeAgents, agentStatus, promptChoices }
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
  ipcMain.handle('terminal:set-issue', (_event, tabId: string, issue: string, persistSessionTitle = false) => {
    const group = switchController.groups.get(tabId)
    if (group) for (const member of group.members) { const memberInfo = tabInfo.get(member); if (memberInfo) memberInfo.issue = issue }
    tabId = switchController.active(tabId)
    const info = tabInfo.get(tabId)
    if (info) {
      info.issue = issue
      if (persistSessionTitle) {
        // Persist any IDs already known immediately. Keep the rename pending
        // when no ID exists yet (including a tab renamed before the agent is
        // launched), or while a watcher is waiting for a continuation/fork.
        const persisted = persistTabSessionTitle(info, issue)
        info.pendingSessionTitle = !persisted || tabSessionWatchers.has(tabId) || tabCodexSessionWatchers.has(tabId)
          ? issue.trim().slice(0, 120)
          : null
      }
      tabInfo.set(tabId, info)
    }
  })

  // List all tab info (for sidebar), sorted by most recently user-input first
  ipcMain.handle('terminal:list-info', () => {
    const now = Date.now()
    return [...tabOrder]
      .map((logicalId) => {
        const id = switchController.active(logicalId)
        const info = tabInfo.get(id)
        const lastOutputAt = tabLastOutputAt.get(id) ?? 0
        const lastInputAt = tabLastInputAt.get(id) ?? 0
        // "active" = PTY had output within the last 3 s (agent is generating)
        const active = (now - lastOutputAt) < 3000
        const isAgentRunning = isAgentTab(info)
        const isClaudeRunning = isAgentRunning && !!info?.hadClaude
        const isGeminiRunning = isAgentRunning && !!info?.hadGemini
        const isCodexRunning = isAgentRunning && !!info?.hadCodex
        const isThinking = isAgentRunning && active
        // Compute (and prune expired done entries) BEFORE reading info.activeAgents below
        const agentStatus = computeTabAgentStatus(id)
        // Quick-answer chips: only scan the buffer for select-prompt choices while waiting for input
        // 'attention' already implies non-stale detected choices (computeTabAgentStatus)
        const promptChoices = agentStatus === 'attention' ? extractPromptChoices(tabLastOutput.get(id) || '') : []

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

        if (!info) return { id, cwd: '', proc: '', issue: '', latestInput: '', claudeSessionId: null, lastOutput: '', active, lastInputAt, isThinking: false, isResuming: false, model: null, activeAgents: [], agentStatus: 'none' as TabAgentStatus, promptChoices: [] as PromptChoice[] }
        return {
          id: logicalId,
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
          agentStatus,
          promptChoices,
        }
      })
      .sort((a, b) => b.lastInputAt - a.lastInputAt)
  })

  // Load saved session — clears all existing PTY state first to prevent tab accumulation on HMR reloads
  ipcMain.handle('session:load', () => {
    handoffDrafts.clear()
    switchController.clear()
    // Kill and clear all existing terminals before restoring
    for (const timer of tabTimers.values()) clearInterval(timer)
    tabTimers.clear()
    for (const proc of ptyProcesses.values()) {
      try { proc.kill() } catch { /* ignore */ }
    }
    ptyProcesses.clear()
    tabInfo.clear()
    tabInputBuf.clear()
    tabInputUncertain.clear()
    tabLastOutput.clear()
    tabLastOutputAt.clear()
    tabLastInputAt.clear()
    tabDetectScanBuf.clear()
    tabResumeCooldown.clear()
    agentMsgQueue.length = 0
    tabSentAgentMsgKeys.clear()
    tabAgentMarkerSeen.clear()
    tabAgentOscBuf.clear()
    for (const t of tabResumeWatch.values()) clearTimeout(t)
    tabResumeWatch.clear()
    for (const w of tabSessionWatchers.values()) clearInterval(w)
    tabSessionWatchers.clear()
    for (const w of tabGeminiSessionWatchers.values()) clearInterval(w)
    tabGeminiSessionWatchers.clear()
    for (const w of tabCodexSessionWatchers.values()) clearInterval(w)
    tabCodexSessionWatchers.clear()
    tabOrder.length = 0
    // Keep runtime IDs monotonic: cancelled async handoffs may still unwind.
    closedTabsHistory.length = 0

    return loadSession()
  })

  // Close a terminal tab
  ipcMain.on('terminal:close', (_event: Electron.IpcMainEvent, tabId: string) => {
    // Save to closed history if had an agent session
    const closingInfo = tabInfo.get(switchController.active(tabId))
    if (closingInfo?.hadClaude) {
      const sessionId = closingInfo.claudeSessionId || closingInfo.claudeResumeParentId
      if (sessionId && sessionHasConversation(sessionId, closingInfo.cwd || HOME)) {
        closedTabsHistory.unshift({
          issue: closingInfo.issue, cwd: closingInfo.cwd || HOME,
          claudeSessionId: sessionId, codexSessionId: null, agent: 'claude', closedAt: Date.now(),
          // Reopen from history replays `claude --model X --resume …`, so this must be
          // the explicit launch flag, not the banner-detected display model.
          model: closingInfo.launchModel,
        })
        if (closedTabsHistory.length > 10) closedTabsHistory.pop()
      }
    } else if (closingInfo?.hadGemini) {
      const sessionFile = closingInfo.geminiSessionFile || getLastGeminiSessionFile(closingInfo.cwd || HOME)
      if (sessionFile) {
        closedTabsHistory.unshift({
          issue: closingInfo.issue, cwd: closingInfo.cwd || HOME,
          claudeSessionId: null, codexSessionId: null, agent: 'gemini', closedAt: Date.now(),
          model: null,
        })
        if (closedTabsHistory.length > 10) closedTabsHistory.pop()
      }
    } else if (closingInfo?.hadCodex) {
      const codexSessionId = isCodexUuid(closingInfo.codexSessionId)
        ? closingInfo.codexSessionId
        : getLastCodexSessionId(closingInfo.cwd || HOME)
      closedTabsHistory.unshift({
        issue: closingInfo.issue, cwd: closingInfo.cwd || HOME,
        claudeSessionId: null, codexSessionId, agent: 'codex', closedAt: Date.now(),
        model: null,
      })
      if (closedTabsHistory.length > 10) closedTabsHistory.pop()
    }

    handoffDrafts.close(tabId)
    switchController.close(tabId)
    const timer = tabTimers.get(tabId)
    if (timer) { clearInterval(timer); tabTimers.delete(tabId) }
    tabInfo.delete(tabId)
    tabInputBuf.delete(tabId)
    tabInputUncertain.delete(tabId)
    tabLastOutput.delete(tabId)
    tabLastOutputAt.delete(tabId)
    tabLastInputAt.delete(tabId)
    tabDetectScanBuf.delete(tabId)
    tabModelScanBuf.delete(tabId)
    tabSentAgentMsgKeys.delete(tabId)
    tabAgentMarkerSeen.delete(tabId)
    tabAgentOscBuf.delete(tabId)
    const sw = tabSessionWatchers.get(tabId)
    if (sw) { clearInterval(sw); tabSessionWatchers.delete(tabId) }
    const cw = tabCodexSessionWatchers.get(tabId)
    if (cw) { clearInterval(cw); tabCodexSessionWatchers.delete(tabId) }
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
    tabId = switchController.active(tabId)
    const info = tabInfo.get(tabId)
    return !!(info?.hadClaude || info?.hadGemini || info?.hadCodex)
  })

  // Get recently closed tab history (for restore menu)
  ipcMain.handle('terminal:get-closed-history', () => {
    return [...closedTabsHistory]
  })

  // Remove an entry from closed history after restore
  ipcMain.on('terminal:remove-closed-history', (_event: Electron.IpcMainEvent, sessionId: string) => {
    const idx = closedTabsHistory.findIndex((e) => e.claudeSessionId === sessionId || e.codexSessionId === sessionId)
    if (idx !== -1) closedTabsHistory.splice(idx, 1)
  })

  // Relay renderer input → pty, and capture prompts / detect claude launch
  ipcMain.on('terminal:input', (_event: Electron.IpcMainEvent, tabId: string, data: string, requireUnswitched = false) => {
    // Legacy composer's delayed attachment/Enter writes must expire as soon as
    // this logical tab starts using handoff, even after cancellation or A→B→A.
    const inputGroup = switchController.groups.get(tabId)
    if (requireUnswitched && inputGroup && (inputGroup.pending || inputGroup.recovery || inputGroup.lastAttempt || inputGroup.history.length)) return
    tabId = switchController.active(tabId)
    if (switchController.blocked(tabId)) return
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
        tabInputUncertain.delete(tabId)
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

    // Some CLIs create their transcript only after the first prompt. The
    // startup watcher may have expired while the user was deciding what to ask.
    // Take the new-file snapshot BEFORE submitting so a delayed first turn is
    // still bound to this tab instead of falling back to another recent session.
    const inputInfo = tabInfo.get(tabId)
    if (proc && isEnter && isAgentTab(inputInfo)) {
      if (inputInfo?.hadClaude && !inputInfo.claudeSessionId && !inputInfo.claudeResumeParentId && !tabSessionWatchers.has(tabId)) {
        startSessionWatch(tabId, inputInfo.cwd || HOME)
      }
      if (inputInfo?.hadCodex && !inputInfo.codexSessionId && !tabCodexSessionWatchers.has(tabId)) {
        startCodexSessionWatch(tabId, inputInfo.cwd || HOME)
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
      tabInputUncertain.delete(tabId)

      if (isShell) {
        // Detect "gemini" command
        if (/^gemini(\s|$)/.test(input)) {
          info.hadGemini = true
          tabInfo.set(tabId, info)
          startGeminiSessionWatch(tabId, info.cwd || HOME)
          if (/--resume/.test(input)) {
            tabResumeCooldown.set(tabId, Date.now() + RESUME_COOLDOWN_MS)
          }
        }

        // Detect "codex" command being launched from shell
        if (/^codex(\s|$)/.test(input)) {
          info.hadCodex = true
          // If resuming a specific session ("codex resume <uuid>"), keep that ID as
          // the fallback; the watcher overwrites it with the new rollout's UUID once
          // codex forks the conversation into a fresh rollout file.
          const resumeMatch = input.match(/\bresume\s+([0-9a-f-]{36})\b/i)
          if (resumeMatch && isCodexUuid(resumeMatch[1])) {
            info.codexSessionId = resumeMatch[1]
            // Suppress [[SEND:]] detection during resume replay
            tabResumeCooldown.set(tabId, Date.now() + RESUME_COOLDOWN_MS)
          }
          tabInfo.set(tabId, info)
          startCodexSessionWatch(tabId, info.cwd || HOME)
        }

        // Detect "claude" command being launched from shell → snapshot NOW before file is created
        if (/^claude(\s|$)/.test(input)) {
          info.hadClaude = true
          // Machine-detect the model from the launch args (--model sonnet / --model=sonnet).
          // This is the ONLY place that sets `info.launchModel` (explicit user choice:
          // model chip, hand-typed flag, or our own restore/reopen command replay).
          // `info.model` (badge) gets the same provisional value; the stdout startup-banner
          // detection later overwrites `info.model` only, never `info.launchModel`.
          // No flag or unknown value → both null (badge fills in once the banner is detected;
          // launchModel stays null so the CLI/settings.json default is respected on restore).
          const modelMatch = input.match(/--model[=\s]+(\S+)/)
          const explicitModel = modelMatch ? normalizeClaudeModel(modelMatch[1]) : null
          info.launchModel = explicitModel
          info.model = explicitModel
          // If resuming a specific session, save the ID directly
          const resumeMatch = input.match(/--resume\s+([a-f0-9-]{36})/)
          if (resumeMatch) {
            // Save the parent session ID as fallback; watcher will update claudeSessionId
            // to the new continuation file Claude creates on --resume
            info.claudeSessionId = resumeMatch[1]
            info.claudeResumeParentId = resumeMatch[1]
            tabInfo.set(tabId, info)
            startSessionWatch(tabId, info.cwd || HOME)
            // Suppress [[SEND:]] detection during resume replay
            tabResumeCooldown.set(tabId, Date.now() + RESUME_COOLDOWN_MS)
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
          // Resume replay is over — user is now interacting, allow [[SEND:]] detection
          tabResumeCooldown.delete(tabId)
        }
      }
    } else trackDraftInput(tabId, data)
  })

  // Answer a select prompt via a quick-answer chip: write "<num>\r" to the PTY and
  // record when it was sent, so stale (already-answered) prompt chips are suppressed
  // until new output arrives (see isPromptChoicesStale)
  ipcMain.handle('terminal:send-choice', (_event, tabId: string, num: string) => {
    tabId = switchController.active(tabId)
    if (switchController.blocked(tabId)) return
    const proc = ptyProcesses.get(tabId)
    if (!proc) return
    proc.write(num + '\r')
    const info = tabInfo.get(tabId)
    if (info) {
      info.lastChoiceSentAt = Date.now()
      tabInfo.set(tabId, info)
    }
  })

  // Handle resize (with tabId)
  ipcMain.on('terminal:resize', (_event: Electron.IpcMainEvent, tabId: string, cols: number, rows: number) => {
    tabId = switchController.active(tabId)
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

  // Create a new tab running inside a fresh git worktree of the source tab's repo.
  // Parallel workers editing the same working tree cause commit mix-ups and
  // pull/rebase conflicts — a dedicated worktree per tab avoids that structurally.
  // Returns a structured result ({ ok, ... }) instead of rejecting so the renderer
  // gets clean error messages (ipcMain.handle rejections are wrapped by Electron).
  ipcMain.handle('terminal:create-worktree', async (_event, tabId: string, branchName?: string) => {
    tabId = switchController.active(tabId)
    const cwd = tabInfo.get(tabId)?.cwd || HOME
    const git = (args: string[], opts: { cwd: string; timeout: number }) =>
      new Promise<string>((resolve, reject) => {
        execFile('git', args, { ...opts, encoding: 'utf-8' }, (err, stdout, stderr) => {
          if (err) reject(new Error((stderr || err.message || '').trim()))
          else resolve(stdout.trim())
        })
      })

    let repoRoot: string
    try {
      repoRoot = await git(['rev-parse', '--show-toplevel'], { cwd, timeout: 5000 })
    } catch {
      return { ok: false as const, error: 'gitリポジトリではありません' }
    }

    // Default branch: wt-YYYYMMDD-HHmmss (no date helper exists elsewhere in this file)
    const branch = (branchName || '').trim() || (() => {
      const d = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      return `wt-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    })()

    // Worktree goes next to the repo: <repoName>-wt-<branch> (slashes in branch → '-';
    // skip the extra "wt-" when the branch itself already starts with it)
    const repoName = path.basename(repoRoot)
    const safeBranch = branch.replace(/[/\\]/g, '-')
    const dirName = safeBranch.startsWith('wt-') ? `${repoName}-${safeBranch}` : `${repoName}-wt-${safeBranch}`
    const worktreePath = path.join(path.dirname(repoRoot), dirName)
    if (fs.existsSync(worktreePath)) {
      return { ok: false as const, error: `${worktreePath} は既に存在します` }
    }

    try {
      await git(['worktree', 'add', worktreePath, '-b', branch], { cwd: repoRoot, timeout: 15000 })
    } catch (e) {
      return { ok: false as const, error: `git worktree add に失敗: ${(e as Error).message}` }
    }

    const { id } = spawnPty(worktreePath)
    return { ok: true as const, tabId: id, worktreePath, branch }
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

  // Resume sessions: merged list of Claude sessions (~/.claude/projects/) and
  // Codex sessions (~/.codex/sessions/), tagged with agent: 'claude' | 'codex'.
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
      automaticTitle: string
      hasCustomTitle: boolean
      projectDir: string
      updatedAt: number
      sizeBytes: number
      agent: 'claude' | 'codex'
      cwd?: string
    }> = []
    const titleOverrides = readSessionTitleOverrides()

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
        const customTitle = titleOverrides[sessionTitleOverrideKey('claude', id)]
        const extractedTitle = cachedClaudeSessionTitle(filePath, stat)
        // Empty startup/bridge JSONL files are not resumable conversations and
        // have no meaningful label. Do not surface them as UUID-only rows.
        if (!extractedTitle && !customTitle) continue
        const automaticTitle = extractedTitle || id
        sessions.push({
          id,
          title: customTitle || automaticTitle,
          automaticTitle,
          hasCustomTitle: !!customTitle,
          projectDir: dir,
          updatedAt: stat.mtimeMs,
          sizeBytes: stat.size,
          agent: 'claude',
        })
      }
    }

    // Codex sessions. The projectDirs filter (encoded ~/.claude/projects dir
    // names) is applied by re-encoding each rollout's cwd with the same
    // deterministic one-way transform Claude Code uses (non-alphanumeric → '-')
    // and matching against basename(projectDir).
    try {
      const encodeCwd = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-')
      const wantedEncoded = projectDirs && projectDirs.length > 0
        ? new Set(projectDirs.map((d) => path.basename(d)))
        : null
      for (const s of listCodexSessions()) {
        if (wantedEncoded && !wantedEncoded.has(encodeCwd(s.cwd))) continue
        const customTitle = titleOverrides[sessionTitleOverrideKey('codex', s.id)]
        sessions.push({
          id: s.id,
          title: customTitle || s.title,
          automaticTitle: s.title,
          hasCustomTitle: !!customTitle,
          projectDir: s.cwd,
          updatedAt: s.updatedAt,
          sizeBytes: s.sizeBytes,
          agent: 'codex',
          cwd: s.cwd,
        })
      }
    } catch { /* codex listing is best-effort */ }

    sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    return sessions
  })

  ipcMain.handle('resume:set-title-override', (_event, agent: ResumableAgent, sessionId: string, title: string | null) => {
    if (agent !== 'claude' && agent !== 'codex') return false
    if (title !== null && typeof title !== 'string') return false
    return setSessionTitleOverride(agent, sessionId, title)
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
    switchController.clear()

    for (const timer of tabTimers.values()) clearInterval(timer)
    tabTimers.clear()
    tabInfo.clear()
    tabInputBuf.clear()
    tabInputUncertain.clear()
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
