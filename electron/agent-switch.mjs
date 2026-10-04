import { HandoffContext } from './handoff-context.mjs'

// Coordinates a handoff without destroying the working source session. All CLI
// and filesystem operations are injected so cancellation and rollback are testable.
export class AgentSwitchController {
  constructor(adapter, { timeoutMs = 60000, pollMs = 500 } = {}) {
    this.adapter = adapter; this.timeoutMs = timeoutMs; this.pollMs = pollMs
    this.groups = new Map(); this._metrics = []
  }
  group(id) {
    if (!this.groups.has(id)) this.groups.set(id, { active: id, members: new Set([id]), parked: new Map(), history: [], pending: null, error: '', errorCode: null, recovery: null, lastAttempt: null, progress: null, context: new HandoffContext() })
    return this.groups.get(id)
  }
  active(id) { return this.groups.get(id)?.active ?? id }
  owner(runtime) { for (const [id, group] of this.groups) if (group.members.has(runtime)) return id; return runtime }
  blocked(runtime) { const group = this.groups.get(this.owner(runtime)); return !!group && (!!group.pending || group.active !== runtime) }
  metrics() { return this._metrics.slice() }
  recoveryRuntime(id) { const group = this.groups.get(id); return group?.pending ? null : group?.recovery?.runtime ?? null }
  restoreLineage(id, lineage = {}) {
    const group = this.group(id)
    if (!lineage || typeof lineage !== 'object' || (lineage.parked !== undefined && !Array.isArray(lineage.parked)) || (lineage.history !== undefined && !Array.isArray(lineage.history))) return null
    const parked = Array.isArray(lineage.parked) ? lineage.parked : []
    if (parked.length > 2 || parked.some(item => !item || !['claude', 'codex'].includes(item.agent) || typeof item.sessionId !== 'string' || !item.sessionId || typeof item.cwd !== 'string' || !item.cwd)
      || new Set(parked.map(item => item.agent)).size !== parked.length) return null
    const history = Array.isArray(lineage.history) ? lineage.history : []
    if (history.length > 6 || history.some(item => !item || !['claude', 'codex'].includes(item.agent) || typeof item.text !== 'string')) return null
    const context = HandoffContext.fromSnapshot(lineage.context)
    if (!context) return null
    group.parked = new Map(parked.map(item => [item.agent, item]))
    group.history = history
    group.context = context
    return group
  }
  _progress(group, pending, stage) {
    const now = Date.now(); pending.stages[stage] ??= now
    group.progress = { stage, startedAt: pending.startedAt, stageStartedAt: pending.stages[stage], elapsedMs: now - pending.startedAt }
  }
  _metric(metric, logicalId) {
    this._metrics.push(metric); if (this._metrics.length > 100) this._metrics.splice(0, this._metrics.length - 100)
    try { this.adapter.recordMetric?.(metric, logicalId) } catch { /* metrics must not affect a handoff */ }
  }
  _error(code, message) { const error = new Error(message); error.code = code; return error }
  _cleanupRecovery(group, keepAgent) {
    const recovery = group.recovery
    if (!recovery || recovery.agent === keepAgent || !recovery.created) return
    this.adapter.release(recovery.runtime); group.members.delete(recovery.runtime); group.recovery = null
  }
  async state(id) {
    const group = this.group(id); let source
    try { source = await this.adapter.read(group.active) } catch { /* unavailable */ }
    const progress = group.progress && { ...group.progress, elapsedMs: Date.now() - group.progress.startedAt }
    return { agent: source?.agent ?? null, phase: group.pending ? 'preparing' : group.error ? 'error' : 'idle', target: group.pending?.target ?? null,
      canSwitch: !group.pending && !!source?.ready, reason: group.error || (source?.ready ? '' : source?.reason || '会話の完了を確認できません。'),
      history: group.history.map(({ agent, text }) => ({ agent, text })), progress, errorCode: group.errorCode,
      recovery: !group.pending && group.recovery ? { agent: group.recovery.agent, exited: group.recovery.exited } : null, lastAttempt: group.lastAttempt }
  }
  async enrichedSource(group, source) {
    if (!this.adapter.enrichSource) return source
    try { return await this.adapter.enrichSource(source, [...group.members].filter(id => id !== group.active), [...group.parked.values()]) }
    catch { return { ...source, text: source.text + '\n\n[Obsidian保存ノートを確認できませんでした。会話本文のみ引き継ぎます。]' } }
  }
  async preview(id) {
    const group = this.group(id)
    let source
    try { source = await this.adapter.read(group.active) } catch { /* preserve prior preview */ }
    if (!source?.ready) return { ...group.context.serialize(), ready: false, reason: source?.reason || '会話の完了を確認してから内容を更新してください。' }
    const canonical = group.context.merge(source)
    const enriched = await this.enrichedSource(group, { ...source, text: canonical.text })
    return { ...canonical, text: enriched.text, ready: true, reason: '' }
  }
  async switch(id, target) {
    const group = this.group(id)
    if (group.pending) return { ok: false, error: '引き継ぎ中です。', errorCode: 'in_progress' }
    if (!['claude', 'codex'].includes(target)) return { ok: false, error: '未対応の切り替え先です。', errorCode: 'unsupported_target' }
    const pending = { target, token: this.adapter.token(), runtime: null, created: false, promptDelivered: false, cancelled: false, startedAt: Date.now(), stages: {} }
    group.pending = pending; group.error = ''; group.errorCode = null; group.progress = null
    let source, mode = 'new', outcome = 'failed', errorCode = null, activatedAt = null
    try {
      this._progress(group, pending, 'reading')
      try { source = await this.adapter.read(group.active) } catch { throw this._error('source_unavailable', '切り替え元の会話を読み取れません。') }
      if (!source?.ready || !source.agent || source.agent === target) throw this._error(source?.errorCode || 'source_unavailable', source?.reason || '切り替え元の会話は引き継げる状態ではありません。')
      if (pending.cancelled) throw this._error('cancelled', '切り替えを取り消しました。')
      this._cleanupRecovery(group, target)
      source = await this.enrichedSource(group, { ...source, text: group.context.merge(source).text })
      const prompt = this.adapter.prompt(source, pending.token); let existing = null
      const recovery = group.recovery
      if (recovery?.agent === target) {
        if (recovery.exited || this.adapter.exited(recovery.runtime)) {
          recovery.exited = true; this.adapter.release(recovery.runtime); group.members.delete(recovery.runtime); group.recovery = null
        } else {
          const saved = await this.adapter.read(recovery.runtime)
          if (!saved.ready) throw this._error('setup_not_ready', '復帰先の会話が入力待ちではありません。設定を完了してから再試行してください。')
          existing = recovery.runtime
        }
      }
      // A parked descriptor stays authoritative until receipt verification. A
      // live recovery is reused first; an exited one falls back to this exact
      // descriptor, never to a fresh target session.
      const parked = group.parked.get(target)
      if (!existing && parked) {
        if (!this.adapter.restoreParked) throw this._error('parked_session_unavailable', '保存された待機会話を復元できません。')
        const restored = await this.adapter.restoreParked(id, parked, prompt, pending.token)
        if (!restored?.runtime) throw this._error(restored?.errorCode || 'parked_session_unavailable', restored?.reason || '保存された待機会話を復元できません。')
        pending.runtime = restored.runtime; pending.created = false; pending.promptDelivered = true; group.members.add(pending.runtime); existing = pending.runtime
      }
      if (!existing) for (const runtime of group.members) {
        if (runtime === group.active) continue
        const saved = await this.adapter.read(runtime)
        if (saved.agent !== target) continue
        if (!saved.ready) { group.recovery = { agent: target, runtime, exited: this.adapter.exited(runtime), created: false }; throw this._error('setup_not_ready', '復帰先の会話が入力待ちではありません。設定を完了してから再試行してください。') }
        existing = runtime; break
      }
      if (pending.cancelled) throw this._error('cancelled', '切り替えを取り消しました。')
      this._progress(group, pending, 'starting')
      if (existing) { pending.runtime = existing; mode = 'reuse'; if (!pending.promptDelivered) await this.adapter.send(existing, prompt) }
      else {
        if (this.adapter.preflight) await this.adapter.preflight(target, source.cwd)
        if (pending.cancelled) throw this._error('cancelled', '切り替えを取り消しました。')
        pending.runtime = await this.adapter.create(target, source.cwd, prompt, pending.token); pending.created = true; group.members.add(pending.runtime)
      }
      const deadline = pending.startedAt + this.timeoutMs
      while (!pending.cancelled && Date.now() < deadline) {
        if (this.adapter.exited(pending.runtime)) throw this._error('target_exited', '切り替え先が終了しました。元の作業を維持しています。')
        // Read first: the transcript itself is an observed startup signal and the
        // host may update its runtime status as a side effect of this read.
        const result = await this.adapter.read(pending.runtime)
        if (result.errorCode) throw this._error(result.errorCode, result.reason || '切り替え先の会話を検証できませんでした。')
        group.context.registerReceipt(result, prompt, pending.token)
        const status = this.adapter.status ? await this.adapter.status(pending.runtime) : { started: true }
        if (status?.errorCode) throw this._error(status.errorCode, status.reason || '切り替え先を開始できませんでした。')
        if (!status?.started && !result.ready && !result.text) { this._progress(group, pending, 'starting'); await new Promise(resolve => setTimeout(resolve, this.pollMs)); continue }
        this._progress(group, pending, 'waiting')
        if (result.ready && result.lastEventAt >= pending.startedAt && result.lastAssistantText?.split(/\r?\n/).some(line => line.trim() === `AC_HANDOFF_READY:${pending.token}`)) {
          if (pending.cancelled) break
          group.context.merge(result)
          group.history.push({ agent: source.agent, text: source.text }); group.history = group.history.slice(-6)
          group.active = pending.runtime; group.pending = null; group.progress = null; group.recovery = null; group.parked.delete(target)
          activatedAt = Date.now(); this.adapter.activate(id, group.active); outcome = 'success'; return { ok: true }
        }
        await new Promise(resolve => setTimeout(resolve, this.pollMs))
      }
      throw this._error(pending.cancelled ? 'cancelled' : 'timeout', pending.cancelled ? '切り替えを取り消しました。' : '引き継ぎを確認できませんでした。切り替え先のログイン・初回設定を確認してください。元の作業は維持しています。')
    } catch (error) {
      errorCode = pending.cancelled ? 'cancelled' : error?.code || 'failed'; outcome = errorCode === 'cancelled' ? 'cancelled' : 'failed'
      if (pending.runtime) {
        const exited = this.adapter.exited(pending.runtime)
        if (outcome === 'cancelled' && pending.created) { this.adapter.release(pending.runtime); group.members.delete(pending.runtime); if (group.recovery?.runtime === pending.runtime) group.recovery = null }
        else group.recovery = { agent: target, runtime: pending.runtime, exited, created: pending.created }
      }
      group.error = error instanceof Error ? error.message : '切り替えに失敗しました。'; group.errorCode = errorCode
      return { ok: false, error: group.error, errorCode }
    } finally {
      const end = Date.now(), stages = pending.stages
      const waitEnd = activatedAt ?? end
      const durations = { readMs: (stages.starting ?? end) - pending.startedAt, startMs: (stages.waiting ?? end) - (stages.starting ?? end), waitMs: waitEnd - (stages.waiting ?? waitEnd), activateMs: activatedAt === null ? 0 : end - activatedAt, totalMs: end - pending.startedAt }
      // Durations end at dispatch; a renderer-ready acknowledgement is recorded by
      // the host later as rendererMs, so these boundaries stay observation-based.
      const metric = { from: source?.agent ?? null, to: target, mode, outcome, errorCode, startedAt: pending.startedAt, durations }
      group.lastAttempt = metric; this._metric(metric, id)
      if (group.pending === pending) group.pending = null
      if (group.progress?.startedAt === pending.startedAt) group.progress = null
    }
  }
  cancel(id) { const pending = this.groups.get(id)?.pending; if (pending) pending.cancelled = true }
  close(id) { const group = this.groups.get(id); if (!group) return; this.cancel(id); for (const runtime of group.members) this.adapter.release(runtime); this.groups.delete(id) }
  clear() { for (const id of [...this.groups.keys()]) this.close(id) }
}
