import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findSessionNotes } from './handoff-notes.mjs';

const id = '123e4567-e89b-42d3-a456-426614174000';
const make = () => { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-notes-')); const vault = path.join(home, 'vault'); fs.mkdirSync(vault); return { home, vault }; };
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

test('discovers only exact frontmatter, basename, explicit report, and Claude Write/Edit paths', async () => {
  const { home, vault } = make();
  try {
    const frontmatter = path.join(vault, 'frontmatter.md');
    const basename = path.join(vault, `saved-${id}.md`);
    const reported = path.join(vault, 'reported.md');
    const tool = path.join(vault, 'tool.md');
    write(frontmatter, `---\nsession_id: ${id}\n---\nfrontmatter body`);
    write(basename, 'basename body'); write(reported, 'reported body'); write(tool, 'tool body');
    write(path.join(vault, 'unrelated.md'), `mentions ${id} in body only`);
    const result = await findSessionNotes({ home, vaultDir: vault, sources: [{ agent: 'claude', sessionId: id, text: `Saved at ${reported}`, toolInputs: [{ name: 'Write', input: { file_path: tool } }] }] });
    assert.equal(result.status, 'partial'); assert.equal(result.notes.length, 3, 'bounded to three associated notes');
    assert.match(result.text, /frontmatter body|basename body|reported body|tool body/);
    assert.doesNotMatch(result.text, /mentions/);
    assert.ok(result.notes.every(note => note.path.startsWith(fs.realpathSync(vault))));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('does not use fuzzy body/date matches, rejects symlink escapes, and reports missing vault cleanly', async () => {
  const { home, vault } = make();
  try {
    write(path.join(vault, 'near.md'), `session_id: ${id.slice(0, -1)}x\nbody ${id}`);
    const outside = path.join(home, 'outside.md'); write(outside, 'outside body');
    try { fs.symlinkSync(outside, path.join(vault, `${id}.md`)); } catch { /* platform may deny links */ }
    const result = await findSessionNotes({ home, vaultDir: vault, sources: [{ sessionId: id, text: outside }] });
    assert.equal(result.notes.length, 0); assert.equal(result.status, 'none');
    const missing = await findSessionNotes({ home, vaultDir: path.join(home, 'missing'), sources: [{ sessionId: id }] });
    assert.deepEqual(missing, { text: '', notes: [], status: 'none', warnings: [] });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('reads only a bounded, exact Claude transcript path to find Write/Edit note paths', async () => {
  const { home, vault } = make();
  try {
    const note = path.join(vault, 'from-tool.md'); write(note, 'tool transcript note');
    const cwd = path.join(home, 'project'); const transcript = path.join(home, '.claude', 'projects', cwd.replaceAll('/', '-'), `${id}.jsonl`);
    write(transcript, JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: note } }] } }) + '\n');
    const result = await findSessionNotes({ home, vaultDir: vault, sources: [{ agent: 'claude', sessionId: id, path: transcript }] });
    assert.equal(result.status, 'found'); assert.equal(result.notes.length, 1); assert.match(result.text, /tool transcript note/);
    write(transcript, '{not json}\n');
    const malformed = await findSessionNotes({ home, vaultDir: vault, sources: [{ agent: 'claude', sessionId: id, path: transcript }] });
    assert.equal(malformed.status, 'partial'); assert.match(malformed.warnings.join(' '), /malformed/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('bounds note text and reports an inaccessible vault without throwing', async () => {
  const { home, vault } = make();
  try {
    write(path.join(vault, `${id}.md`), 'x'.repeat(80_000));
    const result = await findSessionNotes({ home, vaultDir: vault, sources: [{ sessionId: id }] });
    assert.ok(result.text.length <= 6000); assert.equal(result.notes[0].truncated, true); assert.match(result.text, /UNTRUSTED SAVED NOTE/);
    const fileVault = path.join(home, 'not-a-directory'); write(fileVault, 'x');
    const unavailable = await findSessionNotes({ home, vaultDir: fileVault, sources: [{ sessionId: id }] });
    assert.equal(unavailable.status, 'unavailable'); assert.ok(unavailable.warnings.length);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
