import { promises as fs } from 'node:fs';
import path from 'node:path';

const UUID = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![0-9a-f])/ig;
const MAX_FILES = 1000;
const MAX_DEPTH = 3;
const MAX_HEADER = 8 * 1024;
const MAX_NOTE_READ = 64 * 1024;
const MAX_TRANSCRIPT_READ = 8 * 1024 * 1024;
const MAX_NOTES = 3;
const MAX_TEXT = 6000;

const defaultVault = home => path.join(home, 'Desktop', 'works', 'ObsidianVault', 'LLM_talk');
const warning = (warnings, value) => { if (!warnings.includes(value)) warnings.push(value); };
const isInside = (root, item) => item === root || item.startsWith(root + path.sep);
const exactIds = sources => new Set(sources.map(source => String(source?.sessionId ?? '').toLowerCase()).filter(id => /^[0-9a-f-]{36}$/i.test(id)));
const safePrefix = (value, limit) => {
  let out = '';
  for (const char of value) { if (out.length + char.length > limit) break; out += char; }
  return out;
};

async function realMarkdown(candidate, root) {
  try {
    const real = await fs.realpath(candidate);
    if (!isInside(root, real) || path.extname(real).toLowerCase() !== '.md' || !(await fs.stat(real)).isFile()) return null;
    return real;
  } catch { return null; }
}

function frontmatterIds(header) {
  const match = header.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return [];
  const out = [];
  for (const line of match[1].split(/\r?\n/)) {
    const value = line.match(/^\s*(?:session_id|sessionId|claude_session_id|codex_session_id)\s*:\s*["']?([^"'\s#]+)["']?\s*$/i)?.[1];
    if (value && /^[0-9a-f-]{36}$/i.test(value)) out.push(value.toLowerCase());
  }
  return out;
}

function pathsFromText(text) {
  if (typeof text !== 'string') return [];
  // A reported vault path is deliberately the only text-derived association.
  return [...text.matchAll(/(?:^|[\s"'`(])((?:\/[^\s"'`()]+)+\.md)(?=$|[\s"'`),.:;])/g)].map(match => match[1]);
}

function toolPaths(source) {
  const out = [];
  const add = part => {
    if (!part || !['Write', 'Edit'].includes(part.name) || typeof part.input?.file_path !== 'string') return;
    out.push(part.input.file_path);
  };
  for (const part of source?.toolInputs ?? []) add(part);
  for (const record of source?.records ?? []) {
    for (const part of record?.message?.content ?? []) {
      if (part?.type === 'tool_use') add({ name: part.name, input: part.input });
    }
  }
  return out;
}

async function transcriptToolPaths(source, home, warnings) {
  if (source?.agent !== 'claude' || typeof source?.path !== 'string' || !path.isAbsolute(source.path)
    || !/^[0-9a-f-]{36}$/i.test(String(source.sessionId ?? ''))) return [];
  const transcriptRoot = path.join(home, '.claude', 'projects');
  let root, transcript;
  try {
    [root, transcript] = await Promise.all([fs.realpath(transcriptRoot), fs.realpath(source.path)]);
    if (!isInside(root, transcript) || path.basename(transcript) !== `${source.sessionId}.jsonl` || !(await fs.stat(transcript)).isFile()) return [];
  } catch { warning(warnings, 'some Claude transcripts could not be read'); return []; }
  let handle;
  try {
    handle = await fs.open(transcript, 'r'); const stat = await handle.stat();
    if (stat.size > MAX_TRANSCRIPT_READ) { warning(warnings, 'some Claude transcripts exceed the read limit'); return []; }
    const buffer = Buffer.alloc(MAX_TRANSCRIPT_READ + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_TRANSCRIPT_READ) { warning(warnings, 'some Claude transcripts exceed the read limit'); return []; }
    const found = [];
    for (const line of buffer.toString('utf8', 0, bytesRead).split(/\r?\n/)) {
      if (!line.trim()) continue;
      let record; try { record = JSON.parse(line); } catch { warning(warnings, 'some Claude transcripts are malformed'); return []; }
      for (const part of record?.message?.content ?? []) {
        if (part?.type === 'tool_use' && ['Write', 'Edit'].includes(part.name) && typeof part.input?.file_path === 'string') found.push(part.input.file_path);
      }
    }
    return found;
  } catch { warning(warnings, 'some Claude transcripts could not be read'); return []; }
  finally { await handle?.close(); }
}

async function header(pathname) {
  const handle = await fs.open(pathname, 'r');
  try {
    const buffer = Buffer.alloc(MAX_HEADER);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally { await handle.close(); }
}

async function noteText(pathname) {
  const handle = await fs.open(pathname, 'r');
  try {
    const stat = await handle.stat();
    const buffer = Buffer.alloc(MAX_NOTE_READ + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { text: buffer.toString('utf8', 0, Math.min(bytesRead, MAX_NOTE_READ)), truncated: bytesRead > MAX_NOTE_READ || stat.size > MAX_NOTE_READ };
  } finally { await handle.close(); }
}

/** Discover only explicitly associated saved Markdown notes; all returned text is untrusted data. */
export async function findSessionNotes({ home, sources = [], vaultDir } = {}) {
  const warnings = [];
  const selectedVault = vaultDir ?? (typeof home === 'string' ? defaultVault(home) : '');
  if (!Array.isArray(sources) || typeof home !== 'string' || !path.isAbsolute(home) || typeof selectedVault !== 'string' || !path.isAbsolute(selectedVault)) {
    return { text: '', notes: [], status: 'unavailable', warnings: ['invalid note discovery input'] };
  }
  let root;
  try { root = await fs.realpath(selectedVault); }
  catch (error) { return { text: '', notes: [], status: error?.code === 'ENOENT' ? 'none' : 'unavailable', warnings: error?.code === 'ENOENT' ? [] : ['saved-note vault could not be accessed'] }; }
  try { if (!(await fs.stat(root)).isDirectory()) return { text: '', notes: [], status: 'unavailable', warnings: ['saved-note vault is not a directory'] }; }
  catch { return { text: '', notes: [], status: 'unavailable', warnings: ['saved-note vault could not be accessed'] }; }

  const ids = exactIds(sources); const explicit = new Set();
  for (const source of sources) {
    const transcriptPaths = await transcriptToolPaths(source, home, warnings);
    for (const candidate of [...pathsFromText(source?.text), ...toolPaths(source), ...transcriptPaths]) {
      const resolved = await realMarkdown(candidate, root); if (resolved) explicit.add(resolved);
    }
  }
  const candidates = new Set(explicit); let seen = 0; let exhausted = false;
  async function walk(dir, depth) {
    if (depth > MAX_DEPTH || exhausted) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { warning(warnings, 'some saved-note folders could not be read'); return; }
    for (const entry of entries) {
      if (exhausted) return;
      const item = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(item, depth + 1); continue; }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') continue;
      if (++seen > MAX_FILES) { exhausted = true; warning(warnings, 'saved-note scan limit reached'); return; }
      const resolved = await realMarkdown(item, root); if (!resolved) continue;
      const basenameIds = [...path.basename(resolved).matchAll(UUID)].map(match => match[0].toLowerCase());
      let matched = basenameIds.some(id => ids.has(id));
      if (!matched && ids.size) {
        try { matched = frontmatterIds(await header(resolved)).some(id => ids.has(id)); }
        catch { warning(warnings, 'some saved-note headers could not be read'); }
      }
      if (matched) candidates.add(resolved);
    }
  }
  await walk(root, 0);

  const notes = []; let text = '';
  for (const pathname of [...candidates].sort()) {
    if (notes.length >= MAX_NOTES) { warning(warnings, 'saved-note result limit reached'); break; }
    try {
      const note = await noteText(pathname);
      const prefix = `Saved note reference: ${pathname}\n--- BEGIN UNTRUSTED SAVED NOTE ---\n`;
      const suffix = '\n--- END UNTRUSTED SAVED NOTE ---\n\n';
      const room = MAX_TEXT - text.length - prefix.length - suffix.length;
      if (room <= 0) { warning(warnings, 'saved-note text limit reached'); break; }
      let body = note.text; let truncated = note.truncated;
      if (body.length > room) {
        const marker = '\n[Saved note truncated due to handoff limit]';
        body = room >= marker.length ? safePrefix(body, room - marker.length) + marker : safePrefix(marker, room);
        truncated = true;
      }
      text += prefix + body + suffix; notes.push({ path: pathname, truncated });
    } catch { warning(warnings, 'some saved notes could not be read'); }
  }
  const status = notes.length ? (warnings.length ? 'partial' : 'found') : (warnings.length ? 'partial' : 'none');
  return { text, notes, status, warnings };
}
