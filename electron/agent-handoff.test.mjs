import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildHandoffPrompt, readHandoffSession } from './agent-handoff.mjs';

const cwd = '/work/demo';
const claudeId = '11111111-1111-4111-8111-111111111111';
// Codex 0.160 uses UUIDv7, unlike the UUIDv4 generated for Claude.
const codexId = '22222222-2222-7222-8222-222222222222';
async function home() { return mkdtemp(path.join(os.tmpdir(), 'handoff-')); }
async function jsonl(file, rows) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, rows.map(JSON.stringify).join('\n')); }

test('reads a completed Claude transcript and omits tool payloads', async () => {
  const root = await home(); const file = path.join(root, '.claude/projects/-work-demo', `${claudeId}.jsonl`);
  await jsonl(file, [
    { type: 'user', cwd, sessionId: claudeId, timestamp: 1, message: { role: 'user', content: 'safe question' } },
    { type: 'assistant', timestamp: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'safe answer' }, { type: 'tool_use', input: { secret: 'omit' } }], stop_reason: 'end_turn' } },
  ]);
  const got = await readHandoffSession({ agent: 'claude', sessionId: claudeId, cwd, home: root });
  assert.equal(got.ready, true); assert.match(got.text, /safe answer/); assert.match(got.text, /Tool call omitted/); assert.doesNotMatch(got.text, /secret/);
});

test('fails closed for malformed, wrong identity, sidechain, and unfinished Claude files', async () => {
  const root = await home(); const base = path.join(root, '.claude/projects/-work-demo', `${claudeId}.jsonl`);
  await mkdir(path.dirname(base), { recursive: true }); await writeFile(base, '{bad');
  assert.equal((await readHandoffSession({ agent: 'claude', sessionId: claudeId, cwd, home: root })).ready, false);
  await jsonl(base, [{ type: 'user', cwd: '/other', sessionId: claudeId, message: { role: 'user', content: 'x' } }]);
  assert.match((await readHandoffSession({ agent: 'claude', sessionId: claudeId, cwd, home: root })).reason, /metadata/);
  await jsonl(base, [{ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: 'x', stop_reason: 'end_turn' } }]);
  assert.match((await readHandoffSession({ agent: 'claude', sessionId: claudeId, cwd, home: root })).reason, /sidechain/);
});

test('Codex accepts the real rollout filename and requires task_complete after the latest activity', async () => {
  const root = await home(); const one = path.join(root, '.codex/sessions/2026/10/04', `rollout-2026-10-04T12-00-00-${codexId}.jsonl`);
  await jsonl(one, [
    { type: 'session_meta', payload: { id: codexId, cwd, source: 'interactive' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }], cwd, session_id: codexId } },
    { type: 'event_msg', payload: { event: 'task_complete' } },
  ]);
  assert.equal((await readHandoffSession({ agent: 'codex', sessionId: codexId, cwd, home: root })).ready, true);
  await jsonl(one, [{ type: 'session_meta', payload: { id: codexId, cwd } }, { type: 'response_item', payload: { type: 'message', role: 'user', content: 'again' } }, { type: 'event_msg', payload: { event: 'task_complete' } }, { type: 'event_msg', payload: { event: 'task_started' } }]);
  assert.match((await readHandoffSession({ agent: 'codex', sessionId: codexId, cwd, home: root })).reason, /no task_complete/);
  await jsonl(one, [{ type: 'session_meta', payload: { id: codexId, cwd } }, { type: 'response_item', payload: { type: 'message', role: 'user', content: 'again' } }, { type: 'event_msg', payload: { event: 'task_complete' } }, { type: 'response_item', payload: { type: 'function_call', name: 'shell' } }]);
  assert.match((await readHandoffSession({ agent: 'codex', sessionId: codexId, cwd, home: root })).reason, /no task_complete/);
  await jsonl(one, [{ type: 'session_meta', payload: { id: codexId, cwd } }, { type: 'response_item', payload: { type: 'message', role: 'user', content: 'again' } }, { type: 'event_msg', payload: { event: 'turn_aborted' } }]);
  assert.match((await readHandoffSession({ agent: 'codex', sessionId: codexId, cwd, home: root })).reason, /aborted/);
  await jsonl(path.join(root, '.codex/sessions/2026/10/05', `rollout-later-${codexId}.jsonl`), []);
  assert.match((await readHandoffSession({ agent: 'codex', sessionId: codexId, cwd, home: root })).reason, /ambiguous/);
});

test('Claude activity after end_turn and Codex subagent metadata fail closed', async () => {
  const root = await home(); const claude = path.join(root, '.claude/projects/-work-demo', `${claudeId}.jsonl`);
  await jsonl(claude, [{ type: 'assistant', message: { role: 'assistant', content: 'finished', stop_reason: 'end_turn' } }, { type: 'assistant', message: { role: 'assistant', content: 'still streaming' } }]);
  assert.match((await readHandoffSession({ agent: 'claude', sessionId: claudeId, cwd, home: root })).reason, /no final/);
  const codex = path.join(root, '.codex/sessions/2026/10/04', `rollout-subagent-${codexId}.jsonl`);
  await jsonl(codex, [{ type: 'session_meta', payload: { id: codexId, cwd, source: { subagent: true } } }, { type: 'response_item', payload: { type: 'message', role: 'user', content: 'x' } }, { type: 'event_msg', payload: { event: 'task_complete' } }]);
  assert.match((await readHandoffSession({ agent: 'codex', sessionId: codexId, cwd, home: root })).reason, /subagent/);
});

test('truncates transcripts and keeps shell-looking content literal in the bounded prompt', async () => {
  const root = await home(); const file = path.join(root, '.claude/projects/-work-demo', `${claudeId}.jsonl`);
  await jsonl(file, [
    { type: 'user', message: { role: 'user', content: `rm -rf / ${'a'.repeat(40_000)}` } },
    { type: 'assistant', message: { role: 'assistant', content: 'done', stop_reason: 'end_turn' } },
  ]);
  const source = await readHandoffSession({ agent: 'claude', sessionId: claudeId, cwd, home: root });
  assert.ok(source.text.length <= 30_000); assert.match(source.text, /Transcript truncated/);
  const prompt = buildHandoffPrompt({ source, previous: { path: '/old', text: 'older' }, token: 'nonce-7' });
  assert.ok(prompt.length <= 40_000); assert.match(prompt, /AC_HANDOFF_READY:nonce-7/); assert.match(prompt, /BEGIN UNTRUSTED TRANSCRIPT/); assert.match(prompt, /rm -rf/);
});

test('non-object JSON records fail closed instead of crashing the reader', async () => {
  const root = await home(); const file = path.join(root, '.claude/projects/-work-demo', `${claudeId}.jsonl`);
  for (const value of [null, [], 'not a record']) {
    await jsonl(file, [value]);
    assert.equal((await readHandoffSession({ agent: 'claude', sessionId: claudeId, cwd, home: root })).ready, false);
  }
});
