export const SESSION_SCHEMA_VERSION = 5
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function exactClaudeSessionId(info) {
  const id = info?.claudeResumeParentId || info?.claudeSessionId || null
  return typeof id === 'string' && UUID_RE.test(id) ? id : null
}

export function exactCodexSessionId(info) {
  const id = info?.codexSessionId || null
  return typeof id === 'string' && UUID_RE.test(id) ? id : null
}

export function selectedIndex(tabOrder, activeTabId) {
  const index = typeof activeTabId === 'string' ? tabOrder.indexOf(activeTabId) : -1
  return index >= 0 ? index : 0
}

export function mergeRestoreSnapshot(original, liveByIndex, restoreComplete) {
  if (restoreComplete || !original) return null
  const tabs = original.tabs.map((saved, index) => liveByIndex.get(index) ?? saved)
  for (const [index, live] of liveByIndex) {
    if (index >= tabs.length) tabs[index] = live
  }
  return { ...original, tabs: tabs.filter(Boolean) }
}

export function exactGravityConversationId(info) {
  const id = info?.gravityConversationId || null
  return typeof id === 'string' && UUID_RE.test(id) ? id : null
}

export function uniquePendingGravityTab(entries, cwd) {
  const normalized = String(cwd || '')
  const matches = [...entries].filter(([, pendingCwd]) => pendingCwd === normalized)
  return matches.length === 1 ? matches[0][0] : null
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

export function consumeOsc7(previous, data) {
  const raw = `${previous || ''}${data || ''}`.slice(-4096)
  const sequences = []
  let lastEnd = 0
  const pattern = /\x1b\]7;file:\/\/[^\x07\x1b]*(?:\x07|\x1b\\)/g
  for (const match of raw.matchAll(pattern)) {
    sequences.push(match[0])
    lastEnd = match.index + match[0].length
  }
  return { sequences, tail: raw.slice(Math.max(lastEnd, raw.length - 2048)) }
}

export function savedResumeCommand(info, home, gravityCommand = 'agy') {
  if (info?.hadClaude) {
    const id = exactClaudeSessionId(info)
    if (!id) return { ok: false, reason: '保存されたClaudeの会話IDがありません。' }
    const model = typeof info.launchModel === 'string' && /^[a-z0-9._-]+$/i.test(info.launchModel) ? ` --model ${info.launchModel}` : ''
    return { ok: true, command: `claude${model} --resume ${id}\r`, agent: 'claude' }
  }
  if (info?.hadCodex) {
    const id = exactCodexSessionId(info)
    if (!id) return { ok: false, reason: '保存されたCodexの会話IDがありません。' }
    return { ok: true, command: `codex resume ${id}\r`, agent: 'codex' }
  }
  if (info?.hadGravity) {
    const id = exactGravityConversationId(info)
    // Legacy Gemini CLI sessions are intentionally migrated to a fresh Gravity
    // conversation: the two CLIs use incompatible session formats.
    const command = typeof gravityCommand === 'string' && /^[a-z0-9_./~-]+$/i.test(gravityCommand) ? gravityCommand : 'agy'
    return { ok: true, command: id ? `${command} --conversation ${id}\r` : `${command}\r`, agent: 'gravity' }
  }
  return { ok: true, command: null, agent: null }
}
