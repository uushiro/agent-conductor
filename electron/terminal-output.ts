function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*\x07/g, '')          // OSC sequences (e.g. ]0;title BEL)
    .replace(/\x1b\][^\x1b]*\x1b\\/g, '')             // OSC sequences (ST terminated)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')           // CSI sequences
    .replace(/\x1b[a-zA-Z]/g, '')                     // simple escape sequences
}

function displayLines(raw: string): string[] {
  return stripAnsi(raw).replace(/\r/g, '').split('\n')
}

// Strip ANSI/OSC escape codes and extract last meaningful line
export function extractLastLine(raw: string): string {
  const lines = displayLines(raw)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !/^\?.*shortcut/i.test(l))         // filter "? for shortcuts"
    .filter((l) => !/^[>›❯%$]\s*$/.test(l))           // filter bare prompts
    .filter((l) => !/^yuushirokawa@/.test(l))         // filter shell prompt lines

  return lines[lines.length - 1] || ''
}

// --- Selectable prompt choices (quick-answer chips on waiting tabs) ---
// A numbered choice offered by an agent CLI select prompt (e.g. "❯ 1. Yes / 2. No")
export interface PromptChoice {
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
export function extractPromptChoices(rawBuffer: string): PromptChoice[] {
  const lines = displayLines(rawBuffer)
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
// Claude Code / Gravity / Codex TUIs actually use to render error banners. Prose
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
export function extractCriticalError(rawBuffer: string): boolean {
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

// Extract the current Claude action from PTY buffer.
// Scans backward for tool calls (Bash, Read, Write, ...) or thinking indicators.
// Falls back to 'Thinking...' if nothing useful is found.
export function extractClaudeAction(raw: string): string {
  const lines = displayLines(raw)
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

    // Gravity tool format: ServerName[method](args)
    const gravityToolMatch = line.match(/^[●•⠿⠸⠼⠦⠧⠇⠏\s]*(.+?)\[(\w+)\](?:\(([^)]*)\))?$/)
    if (gravityToolMatch && gravityToolMatch[1].trim().length > 0 && gravityToolMatch[1].trim().length < 50) {
      const server = gravityToolMatch[1].trim()
      const method = gravityToolMatch[2]
      const arg = gravityToolMatch[3] ? `: ${gravityToolMatch[3].slice(0, 40)}` : ''
      return `${server}[${method}]${arg}`
    }

    // Thinking/processing animations (Claude and Gravity variants)
    if (/Kneading|Thinking|Levitating|Brewing|Brewed|Cooked|Baking|Distilling/i.test(line)) {
      return 'Thinking...'
    }

    // File reading progress
    const readingMatch = line.match(/Reading (\d+ files?)/i)
    if (readingMatch) return `Reading ${readingMatch[1]}`
  }

  return 'Thinking...'
}
