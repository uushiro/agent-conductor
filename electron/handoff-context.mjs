import { createHash } from 'node:crypto';

const MAX_SERIALIZED_CHARS = 30_000;
const digest = value => createHash('sha256').update(String(value)).digest('hex');
const sessionKey = source => `${source.agent ?? 'unknown'}:${source.sessionId ?? 'unknown'}`;

// Claude may wrap a bracketed paste in this exact envelope. Match the entire
// known payload, never a substring/nonce alone, then store the ACTUAL turn hash.
function matchesGeneratedPrompt(text, prompt) {
  // Codex removes trailing submit whitespace from pasted messages. Compare
  // the whole payload modulo that suffix, then store the actual ID and hash.
  if (text.trimEnd() === prompt.trimEnd()) return true;
  const unwrap = value => value.match(/^\s*<pasted_content id="([a-f0-9]{4,64})">\n([\s\S]*)\n<\/pasted_content id="\1">\s*$/)?.[2];
  const wrapped = unwrap(text);
  if (wrapped !== undefined && wrapped.trim() === prompt.trim()) return true;
  const boundary = prompt.indexOf('\n\n');
  if (boundary < 0) return false;
  const header = prompt.slice(0, boundary), body = prompt.slice(boundary + 2);
  if (text.trimEnd() === (header + ' ' + body).trimEnd()) return true;
  if (!text.startsWith(header)) return false;
  const wrappedBody = unwrap(text.slice(header.length));
  return wrappedBody !== undefined && wrappedBody.trim() === body.trim();
}

/**
 * Canonical, text-only handoff history. Receipt removal is deliberately proof
 * based: a nonce by itself is never sufficient to remove a user-authored turn.
 */
export class HandoffContext {
  constructor({ maxRecords = 500, maxBytes = 1_000_000, maxReceipts = 100, maxSeen = maxRecords * 4, maxSessions = 200 } = {}) {
    this.maxRecords = maxRecords; this.maxBytes = maxBytes; this.maxReceipts = maxReceipts;
    this.records = new Map(); this.receipts = new Map(); this.seen = new Map(); this.snapshots = new Map(); this.sequence = 0;
    this.bytes = 0; this.droppedTurns = 0; this.retainedUnknown = 0; this.omittedReceipts = 0; this.truncatedTurns = 0;
    this.maxSeen = maxSeen; this.maxSessions = maxSessions;
  }

  registerReceipt(source, prompt, token) {
    if (!Array.isArray(source?.turns) || !source?.agent || !source?.sessionId) return null;
    const ids = source.turns.filter(turn => typeof turn?.id === 'string').map(turn => turn.id);
    if (new Set(ids).size !== ids.length) return null;
    const exactAck = `AC_HANDOFF_READY:${token}`;
    const userIndexes = source.turns.map((turn, index) => ({ turn, index })).filter(({ turn }) => turn?.role === 'user' && typeof turn.id === 'string' && matchesGeneratedPrompt(turn.text, prompt));
    if (userIndexes.length !== 1) return null;
    const { turn: user, index } = userIndexes[0];
    // An exact token elsewhere in the conversation is authored data unless it is
    // the direct assistant receipt for this exact generated user message.
    const next = source.turns[index + 1];
    const assistant = next?.role === 'assistant' && typeof next.id === 'string' && next.text === exactAck ? { id: next.id, digest: digest(next.text) } : null;
    const receipt = {
      agent: source.agent, sessionId: source.sessionId,
      user: { id: user.id, digest: digest(user.text) },
      assistant,
    };
    const key = sessionKey(source); const list = this.receipts.get(key) ?? [];
    const existing = list.find(item => item.user.id === receipt.user.id && item.user.digest === receipt.user.digest);
    if (existing) {
      if (!existing.assistant && assistant) { existing.assistant = assistant; this.snapshots.delete(key); }
      this.receipts.set(key, list); return existing;
    }
    list.push(receipt); while (list.length > this.maxReceipts) list.shift();
    this.receipts.set(key, list);
    while (this.receipts.size > this.maxSessions) this.receipts.delete(this.receipts.keys().next().value);
    this.snapshots.delete(key); return receipt;
  }

  _receiptProof(source, turn) {
    if (typeof turn.id !== 'string') return false;
    const value = digest(turn.text);
    for (const receipt of this.receipts.get(sessionKey(source)) ?? []) {
      const proof = turn.role === 'user' ? receipt.user : receipt.assistant;
      if (proof && proof.id === turn.id && proof.digest === value) return { receipt, part: turn.role };
    }
    return null;
  }
  _trim() {
    while (this.records.size > this.maxRecords || this.bytes > this.maxBytes) {
      const oldest = this.records.keys().next().value; if (oldest === undefined) break;
      const record = this.records.get(oldest); this.records.delete(oldest); this.bytes -= record.bytes; this.droppedTurns += 1;
    }
  }
  _remember(key) {
    if (this.seen.has(key)) return false;
    this.seen.set(key, true);
    while (this.seen.size > this.maxSeen) this.seen.delete(this.seen.keys().next().value);
    return true;
  }
  _snapshot(source) {
    const parts = Array.isArray(source?.turns)
      ? source.turns.map((turn, index) => `${index}:${turn?.id ?? ''}:${turn?.role ?? ''}:${digest(turn?.text ?? '')}`)
      : [digest(source?.text ?? '')];
    return digest(parts.join('\n'));
  }
  _rememberSnapshot(source, value) {
    const key = sessionKey(source);
    if (this.snapshots.get(key) === value) return false;
    this.snapshots.set(key, value);
    while (this.snapshots.size > this.maxSessions) this.snapshots.delete(this.snapshots.keys().next().value);
    return true;
  }
  _utf8Prefix(text, budget) {
    let out = '', used = 0;
    for (const char of text) { const size = Buffer.byteLength(char); if (used + size > budget) break; out += char; used += size; }
    return out;
  }
  _utf8Suffix(text, budget) { return Array.from(this._utf8Prefix(Array.from(text).reverse().join(''), budget)).reverse().join(''); }
  _boundedText(text) {
    const limit = Math.max(1, Math.floor(this.maxBytes / 2));
    let marker = limit >= 64 ? '\n[Turn content truncated due to bounded storage]\n' : '[truncated]';
    if (Buffer.byteLength(text) <= limit) return { text, truncated: false };
    if (Buffer.byteLength(marker) > limit) marker = this._utf8Prefix(marker, limit);
    const allowance = Math.max(0, limit - Buffer.byteLength(marker));
    const head = this._utf8Prefix(text, Math.floor(allowance / 2));
    const tail = this._utf8Suffix(text, Math.ceil(allowance / 2));
    return { text: `${head}${marker}${tail}`, truncated: true };
  }
  _add(record, key) {
    if (this.records.has(key)) return false;
    const bounded = this._boundedText(record.text); record.text = bounded.text; record.bytes = Buffer.byteLength(record.text);
    if (bounded.truncated) this.truncatedTurns += 1;
    this.records.set(key, record); this.bytes += record.bytes; this._trim(); return true;
  }

  merge(source) {
    let omittedReceipts = 0, added = 0;
    if (!this._rememberSnapshot(source, this._snapshot(source))) return { text: this.serialize().text, stats: { ...this.serialize().stats, omittedReceiptsThisMerge: 0, added } };
    if (Array.isArray(source?.turns)) {
      for (const [index, turn] of source.turns.entries()) {
        if (!turn || !['user', 'assistant'].includes(turn.role) || typeof turn.text !== 'string') continue;
        const receipt = this._receiptProof(source, turn);
        if (receipt) {
          const marker = receipt.part === 'user' ? 'omittedUser' : 'omittedAssistant';
          if (!receipt.receipt[marker]) { receipt.receipt[marker] = true; omittedReceipts += 1; }
          continue;
        }
        const value = digest(turn.text); const stable = typeof turn.id === 'string' && turn.id.length > 0;
        const key = stable ? `turn:${sessionKey(source)}:${turn.role}:${turn.id}:${value}` : `unknown:${sessionKey(source)}:${index}:${turn.role}:${value}`;
        const firstSeen = this._remember(key);
        if (!stable && firstSeen) this.retainedUnknown += 1;
        if (firstSeen && this._add({ id: stable ? turn.id : null, agent: source.agent ?? 'unknown', sessionId: source.sessionId ?? 'unknown', role: turn.role, text: turn.text, timestamp: Number.isFinite(turn.timestamp) ? turn.timestamp : 0, sequence: ++this.sequence }, key)) added += 1;
      }
    } else if (typeof source?.text === 'string' && source.text) {
      // No turns is a compatibility mode: retain a whole source snapshot once per
      // digest rather than silently dropping it on every periodic read.
      const value = digest(source.text); const key = `opaque:${sessionKey(source)}:${value}`;
      if (this._remember(key) && this._add({ id: null, agent: source.agent ?? 'unknown', sessionId: source.sessionId ?? 'unknown', role: 'assistant', text: source.text, timestamp: 0, sequence: ++this.sequence }, key)) added += 1;
    }
    this.omittedReceipts += omittedReceipts;
    return { text: this.serialize().text, stats: { ...this.serialize().stats, omittedReceiptsThisMerge: omittedReceipts, added } };
  }

  serialize() {
    const ordered = [...this.records.values()].sort((a, b) => (a.timestamp - b.timestamp) || (a.sequence - b.sequence));
    const label = turn => `[${turn.agent} ${turn.role}]\n${turn.text}`;
    let text = ordered.map(label).join('\n\n');
    const disclosure = this.droppedTurns ? `[Earlier canonical history dropped due to bounded storage: ${this.droppedTurns} turn(s)]\n\n` : '';
    let truncated = this.truncatedTurns > 0;
    if ((disclosure + text).length > MAX_SERIALIZED_CHARS) {
      truncated = true;
      const allowance = MAX_SERIALIZED_CHARS - disclosure.length - 80;
      const head = text.slice(0, Math.min(7_500, allowance));
      const tail = text.slice(-(allowance - head.length));
      text = `${head}\n\n[Canonical context truncated: middle turns omitted]\n\n${tail}`;
    }
    return { text: disclosure + text, stats: { turnCount: ordered.length, omittedReceipts: this.omittedReceipts, truncated, droppedTurns: this.droppedTurns, retainedUnknown: this.retainedUnknown, truncatedTurns: this.truncatedTurns } };
  }
  exportSnapshot() {
    return { version: 1, records: [...this.records.values()].map(({ id, agent, sessionId, role, text, timestamp, sequence }) => ({ id, agent, sessionId, role, text, timestamp, sequence })),
      receipts: [...this.receipts.entries()].map(([key, proofs]) => ({ key, proofs: proofs.map(({ agent, sessionId, user, assistant, omittedUser, omittedAssistant }) => ({ agent, sessionId, user, assistant, omittedUser: !!omittedUser, omittedAssistant: !!omittedAssistant })) })),
      seen: [...this.seen.keys()],
      droppedTurns: this.droppedTurns, retainedUnknown: this.retainedUnknown, omittedReceipts: this.omittedReceipts, truncatedTurns: this.truncatedTurns };
  }
  static fromSnapshot(snapshot, bounds) {
    const context = new HandoffContext(bounds);
    // Absence means an older saved session; malformed supplied data must never
    // silently become an empty lineage.
    if (snapshot === undefined || snapshot === null) return context;
    if (typeof snapshot !== 'object' || snapshot.version !== 1 || !Array.isArray(snapshot.records) || !Array.isArray(snapshot.receipts)
      || snapshot.records.length > context.maxRecords || snapshot.receipts.length > context.maxSessions) return null;
    const validAgent = value => ['claude', 'codex', 'unknown'].includes(value);
    const validString = (value, max = 1024) => typeof value === 'string' && value.length > 0 && value.length <= max;
    if (snapshot.seen !== undefined && (!Array.isArray(snapshot.seen) || snapshot.seen.length > context.maxSeen || snapshot.seen.some(key => typeof key !== 'string' || key.length > 2300))) return null;
    const receiptKeys = new Set(); let rawBytes = 0;
    for (const item of snapshot.records) {
      if (!item || !validAgent(item.agent) || !validString(item.sessionId) || !['user', 'assistant'].includes(item.role) || typeof item.text !== 'string' || Buffer.byteLength(item.text) > context.maxBytes
        || (item.id !== null && item.id !== undefined && !validString(item.id)) || !Number.isFinite(item.timestamp) || !Number.isSafeInteger(item.sequence)) return null;
      rawBytes += Buffer.byteLength(item.text); if (rawBytes > context.maxBytes) return null;
      const stable = typeof item.id === 'string' && item.id.length > 0;
      const key = stable ? `turn:${item.agent}:${item.sessionId}:${item.role}:${item.id}:${digest(item.text)}` : `restored:${item.agent}:${item.sessionId}:${item.role}:${digest(item.text)}:${context.sequence}`;
      context._remember(key); context._add({ id: stable ? item.id : null, agent: item.agent, sessionId: item.sessionId, role: item.role, text: item.text, timestamp: Number.isFinite(item.timestamp) ? item.timestamp : 0, sequence: ++context.sequence }, key);
    }
    for (const entry of snapshot.receipts) {
      if (!entry || !validString(entry.key) || receiptKeys.has(entry.key) || !Array.isArray(entry.proofs) || entry.proofs.length > context.maxReceipts) return null;
      receiptKeys.add(entry.key);
      for (const proof of entry.proofs) {
        if (!proof || entry.key !== `${proof.agent}:${proof.sessionId}` || !['claude', 'codex'].includes(proof.agent) || !validString(proof.sessionId) || !validString(proof.user?.id)
          || !/^[a-f0-9]{64}$/i.test(proof.user?.digest) || (proof.assistant && (!validString(proof.assistant.id) || !/^[a-f0-9]{64}$/i.test(proof.assistant.digest)))) return null;
      }
      if (entry.proofs.length) context.receipts.set(entry.key, entry.proofs.map(proof => ({ ...proof, user: { ...proof.user }, assistant: proof.assistant && { ...proof.assistant } })));
    }
    for (const key of snapshot.seen ?? []) context._remember(key);
    for (const key of ['droppedTurns', 'retainedUnknown', 'omittedReceipts', 'truncatedTurns']) {
      if (!Number.isSafeInteger(snapshot[key]) || snapshot[key] < 0) return null;
      context[key] = snapshot[key];
    }
    return context;
  }
}
