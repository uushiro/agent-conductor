// Coordinates a handoff without destroying the working source session. All CLI
// and filesystem operations are injected so cancellation and rollback are testable.
export class AgentSwitchController {
  constructor(adapter, { timeoutMs = 60000, pollMs = 500 } = {}) {
    this.adapter = adapter
    this.timeoutMs = timeoutMs
    this.pollMs = pollMs
    this.groups = new Map()
  }

  group(id) {
    if (!this.groups.has(id)) this.groups.set(id, { active: id, members: new Set([id]), history: [], pending: null, error: '' })
    return this.groups.get(id)
  }

  active(id) { return this.groups.get(id)?.active ?? id }
  owner(runtime) {
    for (const [id, group] of this.groups) if (group.members.has(runtime)) return id
    return runtime
  }
  blocked(runtime) {
    const group = this.groups.get(this.owner(runtime))
    return !!group && (!!group.pending || group.active !== runtime)
  }

  async state(id) {
    const group = this.group(id)
    let source
    try { source = await this.adapter.read(group.active) } catch { /* unavailable */ }
    return {
      agent: source?.agent ?? null,
      phase: group.pending ? 'preparing' : group.error ? 'error' : 'idle',
      target: group.pending?.target ?? null,
      canSwitch: !group.pending && !!source?.ready,
      reason: group.error || (source?.ready ? '' : source?.reason || '会話の完了を確認できません。'),
      history: group.history.map(({ agent, text }) => ({ agent, text })),
    }
  }

  async switch(id, target) {
    const group = this.group(id)
    if (group.pending) return { ok: false, error: '引き継ぎ中です。' }
    if (!['claude', 'codex'].includes(target)) return { ok: false, error: '未対応の切り替え先です。' }
    const token = this.adapter.token()
    const pending = { target, token, runtime: null, created: false, cancelled: false }
    group.pending = pending
    group.error = ''
    const startedAt = Date.now()
    try {
      const source = await this.adapter.read(group.active)
      if (!source.ready || source.agent === target) throw new Error(source.reason || '切り替えできません。')
      const prompt = this.adapter.prompt(source, token)
      let existing
      for (const runtime of group.members) {
        if (runtime === group.active) continue
        const saved = await this.adapter.read(runtime)
        if (saved.agent === target) {
          if (!saved.ready) throw new Error('復帰先の会話が入力待ちではありません。元の作業を維持しています。')
          existing = runtime
          break
        }
      }
      if (pending.cancelled) throw new Error('切り替えを取り消しました。')
      if (existing) {
        pending.runtime = existing
        await this.adapter.send(existing, prompt)
      } else {
        pending.runtime = this.adapter.create(target, source.cwd, prompt, token)
        pending.created = true
        group.members.add(pending.runtime)
      }
      const deadline = startedAt + this.timeoutMs
      while (!pending.cancelled && Date.now() < deadline) {
        const result = await this.adapter.read(pending.runtime)
        // A marker in the startup echo/user prompt is never an acknowledgement.
        if (result.ready && result.lastEventAt >= startedAt && result.lastAssistantText?.trim() === `AC_HANDOFF_READY:${token}`) {
          if (pending.cancelled) break
          group.history.push({ agent: source.agent, text: source.text })
          group.history = group.history.slice(-6)
          group.active = pending.runtime
          group.pending = null
          this.adapter.activate(id, group.active)
          return { ok: true }
        }
        if (this.adapter.exited(pending.runtime)) throw new Error('切り替え先が終了しました。元の作業を維持しています。')
        await new Promise(resolve => setTimeout(resolve, this.pollMs))
      }
      throw new Error(pending.cancelled ? '切り替えを取り消しました。' : '引き継ぎを確認できませんでした。切り替え先のログイン・初回設定を確認してください。元の作業は維持しています。')
    } catch (error) {
      if (pending.runtime && pending.created) {
        this.adapter.release(pending.runtime)
        group.members.delete(pending.runtime)
      }
      group.error = error instanceof Error ? error.message : '切り替えに失敗しました。'
      return { ok: false, error: group.error }
    } finally {
      if (group.pending === pending) group.pending = null
    }
  }

  cancel(id) { const pending = this.groups.get(id)?.pending; if (pending) pending.cancelled = true }
  close(id) {
    const group = this.groups.get(id)
    if (!group) return
    this.cancel(id)
    for (const runtime of group.members) this.adapter.release(runtime)
    this.groups.delete(id)
  }
  clear() { for (const id of [...this.groups.keys()]) this.close(id) }
}
