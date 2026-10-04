import { useCallback, useEffect, useRef, useState } from 'react'

type Agent = 'claude' | 'codex'
type SwitchState = {
  agent: Agent | null
  phase: 'idle' | 'preparing' | 'error'
  canSwitch: boolean
  reason: string
  target: Agent | null
  history: Array<{ agent: Agent; text: string }>
}

interface Props {
  tabId: string
  onPreparingChange: (tabId: string, preparing: boolean) => void
}

const initialState: SwitchState = {
  agent: null, phase: 'idle', canSwitch: false, reason: '読み込み中…', target: null, history: [],
}

export function AgentSwitch({ tabId, onPreparingChange }: Props) {
  const [state, setState] = useState<SwitchState>(initialState)
  const [target, setTarget] = useState<Agent>('codex')
  const [showHistory, setShowHistory] = useState(false)
  const mountedRef = useRef(true)
  const requestInFlight = useRef(false)
  // Retain client errors while continuing to refresh readiness. Freezing the
  // entire state after cancellation would leave canSwitch=false permanently.
  // A still-pending backend handoff remains visible and cancellable.
  const localErrorRef = useRef<string | null>(null)
  // This changes only when the rendered logical tab changes. Polls and the
  // intentionally long-running switch request must not invalidate each other.
  const tabGenerationRef = useRef(0)

  const refresh = useCallback(async () => {
    if (requestInFlight.current) return
    requestInFlight.current = true
    const generation = tabGenerationRef.current
    try {
      const next = await window.electronAPI.getAgentSwitchState(tabId)
      if (mountedRef.current && generation === tabGenerationRef.current) {
        setState(localErrorRef.current && next.phase !== 'preparing'
          ? { ...next, phase: 'error', reason: localErrorRef.current }
          : next)
        setTarget((current) => next.target ?? (current === next.agent ? (next.agent === 'claude' ? 'codex' : 'claude') : current))
        onPreparingChange(tabId, next.phase === 'preparing')
      }
    } catch {
      // The backend can be unavailable during startup; the next poll retries.
    } finally {
      requestInFlight.current = false
    }
  }, [tabId, onPreparingChange])

  useEffect(() => {
    mountedRef.current = true
    localErrorRef.current = null
    setState(initialState)
    setShowHistory(false)
    refresh()
    const timer = window.setInterval(refresh, 1000)
    return () => {
      mountedRef.current = false
      // A response from the previous tab must not update this component after
      // its next render has marked it mounted again for a different tab.
      tabGenerationRef.current += 1
      window.clearInterval(timer)
      onPreparingChange(tabId, false)
    }
  }, [tabId, refresh, onPreparingChange])

  const switchAgent = async () => {
    if (!state.canSwitch || state.phase === 'preparing') return
    const generation = tabGenerationRef.current
    localErrorRef.current = null
    setState((current) => ({ ...current, phase: 'preparing', reason: '' }))
    onPreparingChange(tabId, true)
    try {
      const result = await window.electronAPI.switchAgent(tabId, target)
      if (!mountedRef.current || generation !== tabGenerationRef.current) return
      if (!result.ok) {
        localErrorRef.current = result.error || '引き継ぎを開始できませんでした'
        setState((current) => ({ ...current, phase: 'error', reason: localErrorRef.current! }))
        onPreparingChange(tabId, false)
      }
      refresh()
    } catch {
      if (mountedRef.current && generation === tabGenerationRef.current) {
        localErrorRef.current = '引き継ぎの通信に失敗しました'
        setState((current) => ({ ...current, phase: 'error', reason: localErrorRef.current! }))
        onPreparingChange(tabId, false)
      }
    }
  }

  const cancel = async () => {
    const generation = tabGenerationRef.current
    try {
      await window.electronAPI.cancelAgentSwitch(tabId)
      if (mountedRef.current && generation === tabGenerationRef.current) refresh()
    } catch {
      if (mountedRef.current && generation === tabGenerationRef.current) {
        localErrorRef.current = 'キャンセルの通信に失敗しました'
        setState((current) => ({ ...current, phase: 'error', reason: localErrorRef.current! }))
        onPreparingChange(tabId, false)
      }
    }
  }

  const currentLabel = state.agent === 'claude' ? 'Claude' : state.agent === 'codex' ? 'Codex' : '—'
  const targetLabel = target === 'claude' ? 'Claude' : 'Codex'
  const disabled = !state.canSwitch || state.phase === 'preparing'

  return (
    <section className="agent-switch" aria-label="Agent handoff">
      <div className="agent-switch-main">
        <span className="agent-switch-label">{currentLabel}</span>
        <span className="agent-switch-arrow" aria-hidden="true">→</span>
        <label className="agent-switch-target">
          <span className="sr-only">引き継ぎ先</span>
          <select value={target} onChange={(event) => setTarget(event.target.value as Agent)} disabled={disabled}>
            <option value="claude" disabled={state.agent === 'claude'}>Claude</option>
            <option value="codex" disabled={state.agent === 'codex'}>Codex</option>
          </select>
        </label>
        <button className="agent-switch-submit" type="button" onClick={switchAgent} disabled={disabled} title={disabled ? state.reason : undefined}>
          引き継ぐ
        </button>
        <span className="agent-switch-experimental">Experimental</span>
        <button className="agent-switch-history-toggle" type="button" onClick={() => setShowHistory((value) => !value)} aria-expanded={showHistory}>
          引き継ぎ内容
        </button>
      </div>
      {(state.phase === 'preparing' || state.reason) && <div className="agent-switch-status" aria-live="polite">
        {state.phase === 'preparing' ? <><span>引き継ぎを準備中…</span><button type="button" onClick={cancel}>キャンセル</button></> : <span className={state.phase === 'error' ? 'agent-switch-error' : undefined}>{state.reason}</span>}
      </div>}
      {showHistory && (
        <div className="agent-switch-history">
          <p>モデルは各CLIの設定に従います。</p>
          {state.history.length === 0 ? <p>引き継ぎ内容はまだありません。</p> : state.history.map((entry, index) => (
            <div className="agent-switch-history-entry" key={`${entry.agent}-${index}`}>
              <strong>{entry.agent === 'claude' ? 'Claude' : 'Codex'}</strong>
              <pre>{entry.text}</pre>
            </div>
          ))}
        </div>
      )}
      <span className="sr-only">引き継ぎ先は {targetLabel}</span>
    </section>
  )
}
