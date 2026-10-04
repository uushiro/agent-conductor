// A logical-tab draft never reaches a PTY until an explicit, checked submit.
export class HandoffDrafts {
  constructor(adapter) { this.adapter = adapter; this.drafts = new Map(); this.sending = new Set() }
  get(id) { return this.drafts.get(id) ?? { text: '', revision: 0 } }
  set(id, text) {
    if (typeof text !== 'string' || text.length > 30000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) throw new Error('下書きは30,000文字以内のテキストで入力してください。')
    const next = { text, revision: this.get(id).revision + 1 }; this.drafts.set(id, next); return next
  }
  busy(id) { return this.sending.has(id) }
  async submit(id, revision, destination, submit = true) {
    if (typeof submit !== 'boolean') return { ok: false, error: '送信方法が無効です。' }
    if (this.busy(id)) return { ok: false, error: '送信中です。' }
    const draft = this.get(id)
    if (draft.revision !== revision || !draft.text.trim()) return { ok: false, error: '下書きが更新されています。内容を確認してください。' }
    this.sending.add(id)
    try {
      const target = await this.adapter.destination(id)
      if (!target.ready || !destination || target.token !== destination) return { ok: false, error: '送信先が変わったか、入力待ちではありません。送信先を確認してください。' }
      if (this.get(id).revision !== revision) return { ok: false, error: '下書きが更新されています。内容を確認してください。' }
      this.adapter.write(id, destination, draft.text, submit)
      const cleared = { text: '', revision: revision + 1 }; this.drafts.set(id, cleared)
      return { ok: true, draft: cleared }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : '送信できませんでした。下書きは保持しています。' } }
    finally { this.sending.delete(id) }
  }
  clear() { this.drafts.clear() }
  close(id) { this.drafts.delete(id) }
}
