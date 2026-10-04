import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

type Agent = 'claude' | 'codex'
interface Props { tabId: string; target: Agent; onClose: () => void; onRetry: (target: Agent) => void }

/** A diagnostic terminal for a failed target CLI; the source tab stays usable. */
export function AgentSwitchRecovery({ tabId, target, onClose, onRetry }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const [exited, setExited] = useState(false)
  const [transportError, setTransportError] = useState<string | null>(null)

  const trapFocus = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
    if (event.key !== 'Tab') return
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])]
      .filter((node) => node.offsetParent !== null)
    if (!focusable.length) return
    const index = focusable.indexOf(document.activeElement as HTMLElement)
    const next = event.shiftKey ? (index <= 0 ? focusable.length - 1 : index - 1) : (index === focusable.length - 1 ? 0 : index + 1)
    event.preventDefault()
    focusable[next].focus()
  }, [onClose])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let active = true
    let inFlight = false
    let previousOutput = ''
    setExited(false)
    setTransportError(null)
    const term = new XTerm({
      theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff' }, fontSize: 12,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace", cursorBlink: true, scrollback: 3000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    const reportResize = () => {
      try { fit.fit() } catch { return }
      void window.electronAPI.resizeAgentSwitchRecovery(tabId, term.cols, term.rows).then((ok) => {
        if (active && !ok) setTransportError('対象CLIは終了または準備中のため、サイズを更新できません。')
      }).catch(() => { if (active) setTransportError('対象CLIとの通信に失敗しました。') })
    }
    const observer = new ResizeObserver(reportResize)
    observer.observe(host)
    reportResize()
    const dataDisposable = term.onData((data) => {
      void window.electronAPI.sendAgentSwitchRecoveryInput(tabId, data).then((ok) => {
        if (active && !ok) setTransportError('入力を送信できません。対象CLIは終了または準備中です。')
      }).catch(() => { if (active) setTransportError('対象CLIとの通信に失敗しました。') })
    })
    const poll = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const snapshot = await window.electronAPI.getAgentSwitchRecovery(tabId)
        if (!active) return
        if (!snapshot) { onClose(); return }
        setExited(snapshot.exited)
        if (snapshot.output.startsWith(previousOutput)) term.write(snapshot.output.slice(previousOutput.length))
        else if (snapshot.output !== previousOutput) { term.reset(); term.write(snapshot.output) }
        previousOutput = snapshot.output
      } catch {
        if (active) setTransportError('回復出力を取得できません。')
      } finally { inFlight = false }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 500)
    requestAnimationFrame(() => { if (active) { reportResize(); term.focus() } })
    return () => { active = false; window.clearInterval(timer); observer.disconnect(); dataDisposable.dispose(); term.dispose() }
  }, [tabId, onClose])

  const targetLabel = target === 'claude' ? 'Claude' : 'Codex'
  return <div className="agent-switch-recovery-backdrop" role="presentation">
    <section ref={dialogRef} className="agent-switch-recovery" role="dialog" aria-modal="true" aria-label={`${targetLabel} の引き継ぎ確認`} onKeyDown={trapFocus}>
      <header><div><strong>{targetLabel} の起動を確認</strong><p>ログインや信頼確認が必要な場合は、この画面で操作してください。</p></div><button type="button" onClick={onClose} aria-label="回復画面を閉じる">×</button></header>
      {exited && <p className="agent-switch-recovery-exited">対象CLIは終了しました。出力を確認してから再試行できます。</p>}
      {transportError && <p className="agent-switch-recovery-error" role="status">{transportError}</p>}
      <div className="agent-switch-recovery-terminal" ref={hostRef} />
      <footer><button type="button" onClick={onClose}>元の作業に戻る</button><button type="button" className="agent-switch-recovery-retry" onClick={() => { onClose(); onRetry(target) }}>閉じて再試行</button></footer>
    </section>
  </div>
}
