import assert from 'node:assert/strict';
import test from 'node:test';
import { HandoffContext } from './handoff-context.mjs';

const turn = (id, role, text, timestamp) => ({ id, role, text, timestamp });
const source = (agent, sessionId, turns) => ({ agent, sessionId, text: turns.map(item => item.text).join('\n'), turns });

test('three handoff rounds preserve authored turns without serializing registered nested prompts', () => {
  const context = new HandoffContext();
  const promptAB = 'generated handoff A to B AC_HANDOFF_READY:token-ab';
  const promptBA = 'generated handoff B to A AC_HANDOFF_READY:token-ba';
  const a1 = source('claude', 'a', [turn('a-u1', 'user', 'U1 authored by A', 1)]);
  context.merge(a1);
  const b = source('codex', 'b', [turn('b-r1', 'user', promptAB, 2), turn('b-a1', 'assistant', 'AC_HANDOFF_READY:token-ab', 3), turn('b-u2', 'user', 'U2 authored by B', 4)]);
  assert.ok(context.registerReceipt(b, promptAB, 'token-ab'));
  assert.equal(context.merge(b).stats.omittedReceipts, 2);
  const a3 = source('claude', 'a', [turn('a-u1', 'user', 'U1 authored by A', 1), turn('a-r2', 'user', promptBA, 5), turn('a-a2', 'assistant', 'AC_HANDOFF_READY:token-ba', 6), turn('a-u3', 'user', 'U3 authored by A', 7)]);
  assert.ok(context.registerReceipt(a3, promptBA, 'token-ba'));
  const out = context.merge(a3).text;
  assert.match(out, /U1 authored by A/); assert.match(out, /U2 authored by B/); assert.match(out, /U3 authored by A/);
  assert.doesNotMatch(out, /generated handoff/); assert.doesNotMatch(out, /AC_HANDOFF_READY:token-/);
  assert.match(context.merge(source('codex', 'replacement', [turn('new', 'assistant', 'fresh target', 8)])).text, /U2 authored by B/);
});

test('marker-looking authored turns, wrappers, changed digests, and duplicate IDs are retained', () => {
  const context = new HandoffContext();
  const prompt = 'generated exact prompt AC_HANDOFF_READY:n-1';
  const registered = source('claude', 'a', [turn('receipt', 'user', prompt, 1), turn('ack', 'assistant', 'AC_HANDOFF_READY:n-1', 2)]);
  assert.ok(context.registerReceipt(registered, prompt, 'n-1'));
  context.merge(source('claude', 'a', [turn('receipt', 'user', `<pasted_content id="x">${prompt}</pasted_content>`, 3), turn('ack', 'assistant', 'AC_HANDOFF_READY:n-1 with authored explanation', 4), turn('author', 'user', 'AC_HANDOFF_READY:n-1', 5)]));
  const duplicate = source('codex', 'b', [turn('same', 'user', prompt, 6), turn('same', 'user', `${prompt} changed`, 7)]);
  assert.equal(context.registerReceipt(duplicate, prompt, 'n-1'), null);
  const out = context.merge(duplicate).text;
  assert.match(out, /pasted_content/); assert.match(out, /with authored explanation/); assert.match(out, /\[claude user\]\nAC_HANDOFF_READY:n-1/); assert.match(out, /generated exact prompt/);
});

test('bounded ledger discloses drops and opaque legacy sources stay retained without poll duplication', () => {
  const context = new HandoffContext({ maxRecords: 2, maxBytes: 100_000 });
  const repeated = source('claude', 'a', [turn('1', 'user', 'one', 1), turn('2', 'user', 'two', 2), turn('3', 'user', 'three', 3)]);
  context.merge(repeated);
  const bounded = context.serialize();
  assert.equal(bounded.stats.droppedTurns, 1); assert.match(bounded.text, /Earlier canonical history dropped/);
  context.merge(repeated);
  assert.equal(context.serialize().stats.droppedTurns, 1);
  const fallback = new HandoffContext();
  fallback.merge({ agent: 'claude', sessionId: 'legacy', text: 'legacy snapshot' });
  fallback.merge({ agent: 'claude', sessionId: 'legacy', text: 'legacy snapshot' });
  fallback.merge({ agent: 'claude', sessionId: 'legacy', text: 'changed legacy snapshot' });
  assert.equal(fallback.serialize().stats.turnCount, 2);
});

test('an oversized turn is retained in bounded form without evicting older authored turns', () => {
  const context = new HandoffContext({ maxRecords: 10, maxBytes: 1_000 });
  context.merge(source('claude', 'a', [turn('old', 'user', 'older authored instruction', 1), turn('huge', 'user', `head ${'x'.repeat(20_000)} tail`, 2)]));
  const result = context.serialize();
  assert.match(result.text, /older authored instruction/); assert.match(result.text, /Turn content truncated due to bounded storage/);
  assert.equal(result.stats.droppedTurns, 0);
});

test('receipt registration is idempotent and upgrades a later exact acknowledgement', () => {
  const context = new HandoffContext({ maxReceipts: 2 });
  const prompt = 'generated receipt AC_HANDOFF_READY:poll-token';
  const waiting = source('codex', 'b', [turn('user', 'user', prompt, 1)]);
  for (let index = 0; index < 150; index += 1) context.registerReceipt(waiting, prompt, 'poll-token');
  assert.equal(context.receipts.get('codex:b').length, 1);
  assert.equal(context.receipts.get('codex:b')[0].assistant, null);
  const complete = source('codex', 'b', [turn('user', 'user', prompt, 1), turn('ack', 'assistant', 'AC_HANDOFF_READY:poll-token', 2)]);
  context.registerReceipt(complete, prompt, 'poll-token');
  assert.equal(context.receipts.get('codex:b').length, 1);
  assert.equal(context.receipts.get('codex:b')[0].assistant.id, 'ack');
  assert.equal(context.merge(complete).stats.omittedReceipts, 2);
  context.registerReceipt(complete, prompt, 'poll-token');
  const preview = context.merge(complete).stats;
  assert.equal(preview.omittedReceipts, 2);
  assert.equal(preview.omittedReceiptsThisMerge, 0);
});

test('multibyte oversized turns respect byte bounds and disclose individual truncation', () => {
  const context = new HandoffContext({ maxRecords: 10, maxBytes: 1_000 });
  context.merge(source('claude', 'a', [turn('old', 'user', 'keep this authored instruction', 1), turn('jp', 'assistant', `開始${'😀日本語'.repeat(4_000)}終了`, 2)]));
  const result = context.serialize();
  assert.ok(context.bytes <= 1_000);
  assert.match(result.text, /keep this authored instruction/);
  assert.equal(result.stats.truncated, true);
  assert.ok(result.stats.truncatedTurns >= 1);
});

test('serialization is bounded with an explicit truncation disclosure', () => {
  const context = new HandoffContext({ maxRecords: 10, maxBytes: 100_000 });
  context.merge(source('claude', 'a', [turn('long-1', 'user', `start ${'a'.repeat(20_000)}`, 1), turn('long-2', 'assistant', `end ${'b'.repeat(20_000)}`, 2)]));
  const result = context.serialize();
  assert.ok(result.text.length <= 30_000); assert.equal(result.stats.truncated, true); assert.match(result.text, /Canonical context truncated/);
});

test('snapshot import is bounded and fails closed for malformed receipt linkage', () => {
  const context = new HandoffContext({ maxSessions: 1, maxRecords: 4, maxBytes: 10_000 });
  const prompt = 'generated AC_HANDOFF_READY:restore-token';
  const input = source('codex', 'session-b', [turn('u', 'user', prompt, 1), turn('a', 'assistant', 'AC_HANDOFF_READY:restore-token', 2), turn('kept', 'user', 'authored after restart', 3)]);
  context.registerReceipt(input, prompt, 'restore-token'); context.merge(input);
  const restored = HandoffContext.fromSnapshot(context.exportSnapshot(), { maxSessions: 1, maxRecords: 4, maxBytes: 10_000 });
  assert.ok(restored); assert.match(restored.serialize().text, /authored after restart/);
  const again = restored.merge(input);
  assert.equal(again.stats.turnCount, 1);
  assert.equal(again.stats.omittedReceipts, 2);
  const invalid = context.exportSnapshot(); invalid.receipts[0].key = 'claude:other-session';
  assert.equal(HandoffContext.fromSnapshot(invalid), null);
  assert.equal(HandoffContext.fromSnapshot({ version: 1, records: [], receipts: [{ key: 'x', proofs: [{}] }], droppedTurns: 0, retainedUnknown: 0, omittedReceipts: 0, truncatedTurns: 0 }), null);
});


test('restart preserves seen identities for truncated and unknown-ID authored turns', () => {
  const bounds = { maxBytes: 1000, maxRecords: 5 };
  const context = new HandoffContext(bounds);
  const input = source('claude', 'restart', [turn('large', 'user', '重要'.repeat(1000), 1), turn(null, 'assistant', 'unknown identity retained once', 2)]);
  context.merge(input);
  const restored = HandoffContext.fromSnapshot(context.exportSnapshot(), bounds);
  assert.ok(restored);
  assert.equal(restored.merge(input).stats.turnCount, 2);
});


test('known CLI paste envelopes require exact full generated payload and matching envelope IDs', () => {
  const prompt = 'The user requested receipt AC_HANDOFF_READY:native-token.\n\nSource reference\n--- BEGIN UNTRUSTED TRANSCRIPT ---\nfacts\n--- END UNTRUSTED TRANSCRIPT ---\n';
  const [header, ...rest] = prompt.split('\n\n'); const body = rest.join('\n\n');
  const wrap = content => `\n\n<pasted_content id="759d">\n${content}\n</pasted_content id="759d">\n`;
  for (const text of [wrap(prompt), header + wrap(body), header + ' ' + body]) {
    const context = new HandoffContext();
    const input = source('claude', 'native', [turn('known', 'user', text, 1), turn('ack', 'assistant', 'AC_HANDOFF_READY:native-token', 2)]);
    assert.ok(context.registerReceipt(input, prompt, 'native-token'));
    assert.equal(context.merge(input).stats.turnCount, 0);
  }
  for (const text of [header + wrap(body + 'extra user text'), header + wrap(body).replace('</pasted_content id="759d">', '</pasted_content id="abcd">'), 'unrelated author instruction ' + wrap(prompt)]) {
    const context = new HandoffContext(), input = source('claude', 'native', [turn('authored', 'user', text, 1)]);
    assert.equal(context.registerReceipt(input, prompt, 'native-token'), null);
    assert.equal(context.merge(input).stats.turnCount, 1);
  }
});


test('Codex submit whitespace trimming cannot reinsert a generated handoff', () => {
  const prompt = 'Receive AC_HANDOFF_READY:trim-token.\n\n--- BEGIN UNTRUSTED TRANSCRIPT ---\nkeep exact interior  spaces\n--- END UNTRUSTED TRANSCRIPT ---\n\n';
  const context = new HandoffContext();
  const input = source('codex', 'trim-session', [turn('user-trim', 'user', prompt.trimEnd(), 1), turn('ack-trim', 'assistant', 'AC_HANDOFF_READY:trim-token', 2)]);
  assert.ok(context.registerReceipt(input, prompt, 'trim-token'));
  assert.equal(context.merge(input).stats.turnCount, 0);
  assert.equal(context.merge(input).stats.omittedReceipts, 2);
  const restored = HandoffContext.fromSnapshot(context.exportSnapshot());
  assert.equal(restored.merge(input).stats.turnCount, 0);
  for (const changed of [prompt.trimEnd() + ' extra', prompt.replace('interior  spaces', 'interior spaces'), 'leading ' + prompt, prompt.trimEnd().slice(0, -1)]) {
    const other = new HandoffContext(), authored = source('codex', 'trim-session', [turn('authored', 'user', changed, 1)]);
    assert.equal(other.registerReceipt(authored, prompt, 'trim-token'), null);
    assert.equal(other.merge(authored).stats.turnCount, 1);
  }
});
