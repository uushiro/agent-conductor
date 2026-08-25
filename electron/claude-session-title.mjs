import fs from 'node:fs'

const READ_WINDOW_BYTES = 64 * 1024
const MAX_TITLE_LENGTH = 120

function cleanTitle(value) {
  if (typeof value !== 'string') return null
  const title = value.trim().split(/\r?\n/, 1)[0].trim().slice(0, MAX_TITLE_LENGTH)
  return title || null
}

function parseLines(text) {
  const records = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line)
      if (value && typeof value === 'object' && !Array.isArray(value)) records.push(value)
    } catch { /* a bounded read may contain one partial JSON line */ }
  }
  return records
}

function textFromUserRecord(record) {
  const message = record.message
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null
  const content = message.content
  if (typeof content === 'string') return cleanTitle(content)
  if (!Array.isArray(content)) return null
  for (const part of content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue
    if (part.type === 'text') {
      const title = cleanTitle(part.text)
      if (title) return title
    }
  }
  return null
}

function aiTitleFrom(records) {
  let title = null
  for (const record of records) {
    if (record.type !== 'ai-title') continue
    title = cleanTitle(record.aiTitle) || title
  }
  return title
}

function fallbackUserTitle(records) {
  let firstPlainUserTitle = null
  for (const record of records) {
    if (record.type !== 'user') continue
    const userTitle = textFromUserRecord(record)
    if (!userTitle) continue
    const origin = record.origin
    const isHuman = !!origin && typeof origin === 'object' && !Array.isArray(origin)
      && origin.kind === 'human'
    // Older Claude JSONL files do not have origin.kind. In that format the
    // initial user message is the root record and therefore has no parent.
    const isLegacyRoot = !origin && record.parentUuid === null
    if (isHuman || isLegacyRoot) return userTitle
    // Some transitional Claude versions wrote typed user prompts with neither
    // origin metadata nor a null parent. Preserve the first text-bearing user
    // record as a last resort; tool_result-only records have no text part.
    firstPlainUserTitle ||= userTitle
  }
  return firstPlainUserTitle
}

/**
 * Read a Claude JSONL session without loading the full conversation.
 * Claude writes its generated `ai-title` records repeatedly near the end of a
 * session, while the first human prompt is near the beginning for fallback.
 */
export function readClaudeSessionTitle(filePath) {
  let fd = null
  try {
    const stat = fs.statSync(filePath)
    if (stat.size <= 0) return null
    fd = fs.openSync(filePath, 'r')

    const tailLength = Math.min(READ_WINDOW_BYTES, stat.size)
    const tailStart = stat.size - tailLength
    const tailBuffer = Buffer.alloc(tailLength)
    const tailBytes = fs.readSync(fd, tailBuffer, 0, tailLength, tailStart)
    let tailText = tailBuffer.toString('utf8', 0, tailBytes)
    if (tailStart > 0) {
      const firstNewline = tailText.indexOf('\n')
      tailText = firstNewline >= 0 ? tailText.slice(firstNewline + 1) : ''
    }
    const tailTitle = aiTitleFrom(parseLines(tailText))
    if (tailTitle) return tailTitle

    const headLength = Math.min(READ_WINDOW_BYTES, stat.size)
    const headBuffer = Buffer.alloc(headLength)
    const headBytes = fs.readSync(fd, headBuffer, 0, headLength, 0)
    let headText = headBuffer.toString('utf8', 0, headBytes)
    if (headLength < stat.size) {
      const lastNewline = headText.lastIndexOf('\n')
      headText = lastNewline >= 0 ? headText.slice(0, lastNewline + 1) : ''
    }
    const headRecords = parseLines(headText)
    return aiTitleFrom(headRecords) || fallbackUserTitle(headRecords)
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch { /* ignore close errors */ }
    }
  }
}
