const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function codexMetaFromSessionRecord(record, fileId) {
  const payload = record?.payload ?? record?.session_meta?.payload
  return {
    id: typeof payload?.id === 'string' ? payload.id : null,
    fileId: typeof fileId === 'string' ? fileId : '',
    cwd: typeof payload?.cwd === 'string' ? payload.cwd : null,
    source: payload?.source ?? null,
    originator: typeof payload?.originator === 'string' ? payload.originator : null,
    parentThreadId: typeof payload?.parent_thread_id === 'string' ? payload.parent_thread_id : null,
  }
}

export function isInteractiveCodexMeta(meta) {
  if (!meta) return false
  if (typeof meta.source === 'string') return meta.source === 'cli' || meta.source === 'vscode'
  if (meta.source && typeof meta.source === 'object') return false
  return typeof meta.originator === 'string' && /^(codex-tui|codex_cli_rs|codex_chatgpt.*remote)$/i.test(meta.originator)
}

export function isSubagentCodexMeta(meta) {
  return !!meta?.source && typeof meta.source === 'object' && !Array.isArray(meta.source) &&
    Object.prototype.hasOwnProperty.call(meta.source, 'subagent')
}

export function resolveCodexSessionLineage(requestedId, cwd, metas, maxDepth = 8) {
  if (!UUID_RE.test(String(requestedId || ''))) return { ok: false, code: 'invalid_id' }
  if (typeof cwd !== 'string' || !cwd) return { ok: false, code: 'invalid_cwd' }
  const byId = new Map()
  for (const meta of metas) {
    if (!meta || !UUID_RE.test(String(meta.id || '')) || meta.fileId?.toLowerCase() !== meta.id.toLowerCase()) continue
    if (!byId.has(meta.id.toLowerCase())) byId.set(meta.id.toLowerCase(), meta)
  }
  const seen = new Set()
  let currentId = requestedId
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const key = currentId.toLowerCase()
    if (seen.has(key)) return { ok: false, code: 'lineage_cycle' }
    seen.add(key)
    const meta = byId.get(key)
    if (!meta) return { ok: false, code: depth === 0 ? 'session_missing' : 'parent_missing' }
    if (meta.cwd !== cwd) return { ok: false, code: 'cwd_mismatch' }
    if (isInteractiveCodexMeta(meta)) return { ok: true, id: meta.id, migrated: depth > 0, depth }
    if (!isSubagentCodexMeta(meta)) return { ok: false, code: 'not_interactive' }
    if (!UUID_RE.test(String(meta.parentThreadId || ''))) return { ok: false, code: 'subagent_parent_missing' }
    currentId = meta.parentThreadId
  }
  return { ok: false, code: 'lineage_too_deep' }
}
