import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AgentSwitchRecovery } from './AgentSwitchRecovery'
import type { AgentSwitchAttempt } from '../global'

type Agent = 'claude' | 'codex'
type Progress = { stage: 'reading' | 'starting' | 'waiting'; startedAt: number; stageStartedAt: number; elapsedMs: number }
type SwitchState = {
  agent: Agent | null; phase: 'idle' | 'preparing' | 'error'; canSwitch: boolean; reason: string; target: Agent | null
  history: Array<{ agent: Agent; text: string }>; progress: Progress | null; errorCode: string | null
  recovery: { agent: Agent; exited: boolean } | null; lastAttempt: AgentSwitchAttempt | null
}
interface Props { tabId: string; onPreparingChange: (tabId: string, preparing: boolean) => void }
const initialState: SwitchState = { agent: null, phase: 'idle', canSwitch: false, reason: '読み込み中…', target: null, history: [], progress: null, errorCode: null, recovery: null, lastAttempt: null }
const labelFor = (agent: Agent | null) => agent === 'claude' ? 'Claude' : agent === 'codex' ? 'Codex' : '—'
const stageLabel: Record<Progress['stage'], string> = { reading: '引き継ぎ内容を読み取り中', starting: '切り替え先を起動中', waiting: '切り替え先の準備を待機中' }
const duration = (milliseconds: number | null | undefined) => milliseconds == null ? '—' : `${(milliseconds / 1000).toFixed(milliseconds < 10000 ? 1 : 0)}秒`

function AttemptDetails({ attempt }: { attempt: AgentSwitchAttempt }) {
  const outcome = attempt.outcome === 'success' ? '完了' : attempt.outcome === 'cancelled' ? 'キャンセル' : '失敗'
  return <div className="agent-switch-metrics-entry">
    <strong>{labelFor(attempt.from)} → {labelFor(attempt.to)}</strong>
    <span>{attempt.mode === 'reuse' ? '再利用' : '新規'} / {outcome} / 合計 {duration(attempt.durations.totalMs)}</span>
    <span>読取 {duration(attempt.durations.readMs)} ・ 起動 {duration(attempt.durations.startMs)} ・ 待機 {duration(attempt.durations.waitMs)} ・ 反映 {duration(attempt.durations.activateMs)} ・ 描画準備 {duration(attempt.durations.rendererMs)}</span>
  </div>
}

export function AgentSwitch({ tabId, onPreparingChange }: Props) {
  const [state, setState] = useState<SwitchState>(initialState)
  const [target, setTarget] = useState<Agent>('codex')
  const [showHistory, setShowHistory] = useState(false)
  const [metrics, setMetrics] = useState<AgentSwitchAttempt[]>([])
  const [context, setContext] = useState<{ text: string; stats: { turnCount: number; omittedReceipts: number; truncated: boolean; droppedTurns: number; retainedUnknown: number }; ready: boolean; reason: string } | null>(null)
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [clock, setClock] = useState(Date.now())
  const mountedRef = useRef(true)
  const requestInFlight = useRef(false)
  const localErrorRef = useRef<string | null>(null)
  const tabGenerationRef = useRef(0)

  const refresh = useCallback(async () => {
    if (requestInFlight.current) return
    requestInFlight.current = true
    const generation = tabGenerationRef.current
    try {
      const next = await window.electronAPI.getAgentSwitchState(tabId)
      if (mountedRef.current && generation === tabGenerationRef.current) {
        if (next.lastAttempt?.outcome === 'success') localErrorRef.current = null
        setState(localErrorRef.current && next.phase !== 'preparing' ? { ...next, phase: 'error', reason: localErrorRef.current } : next)
        setTarget((current) => next.target ?? (current === next.agent ? (next.agent === 'claude' ? 'codex' : 'claude') : current))
        onPreparingChange(tabId, next.phase === 'preparing')
      }
    } catch {
      // Startup may race the preload bridge; the next short poll retries.
    } finally { requestInFlight.current = false }
  }, [tabId, onPreparingChange])

  useEffect(() => {
    mountedRef.current = true; localErrorRef.current = null; setState(initialState); setContext(null); setShowHistory(false); setRecoveryOpen(false)
    void refresh()
    const timer = window.setInterval(() => void refresh(), 350)
    return () => { mountedRef.current = false; tabGenerationRef.current += 1; window.clearInterval(timer); onPreparingChange(tabId, false) }
  }, [tabId, refresh, onPreparingChange])


  const refreshContext = useCallback(async () => {
    const generation = tabGenerationRef.current
    try {
      const next = await window.electronAPI.getAgentSwitchContext(tabId)
      if (mountedRef.current && generation === tabGenerationRef.current) setContext(next)
    } catch {
      if (mountedRef.current && generation === tabGenerationRef.current) setContext({ text: '', stats: { turnCount: 0, omittedReceipts: 0, truncated: false, droppedTurns: 0, retainedUnknown: 0 }, ready: false, reason: '引き継ぎ内容を取得できませんでした。' })
    }
  }, [tabId])

  useEffect(() => {
    if (state.phase !== 'preparing') return
    const timer = window.setInterval(() => setClock(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [state.phase])

  useEffect(() => {
    if (showHistory) void refreshContext()
  }, [showHistory, state.lastAttempt?.startedAt, refreshContext])

  useEffect(() => {
    if (!showHistory) return
    let active = true
    let inFlight = false
    const load = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const value = await window.electronAPI.getAgentSwitchMetrics()
        if (active) setMetrics(value)
      } catch {
        // Metrics are supplementary; status polling must remain usable without them.
      } finally { inFlight = false }
    }
    void load()
    const timer = window.setInterval(() => void load(), 500)
    return () => { active = false; window.clearInterval(timer) }
  }, [showHistory, state.lastAttempt?.startedAt])

  const switchAgent = useCallback(async (requestedTarget = target) => {
    if (!state.canSwitch || state.phase === 'preparing') return
    const generation = tabGenerationRef.current
    localErrorRef.current = null; setRecoveryOpen(false)
    setState((current) => ({ ...current, phase: 'preparing', reason: '', progress: current.progress ?? { stage: 'reading', startedAt: Date.now(), stageStartedAt: Date.now(), elapsedMs: 0 } }))
    onPreparingChange(tabId, true)
    try {
      const result = await window.electronAPI.switchAgent(tabId, requestedTarget)
      if (!mountedRef.current || generation !== tabGenerationRef.current) return
      if (!result.ok) {
        localErrorRef.current = result.error || '引き継ぎを開始できませんでした'
        setState((current) => ({ ...current, phase: 'error', reason: localErrorRef.current!, progress: null }))
        onPreparingChange(tabId, false)
      }
      void refresh()
      if (showHistory) void refreshContext()
    } catch {
      if (mountedRef.current && generation === tabGenerationRef.current) {
        localErrorRef.current = '引き継ぎの通信に失敗しました'
        setState((current) => ({ ...current, phase: 'error', reason: localErrorRef.current!, progress: null }))
        onPreparingChange(tabId, false)
      }
    }
  }, [target, state.canSwitch, state.phase, tabId, onPreparingChange, refresh, showHistory, refreshContext])

  const cancel = useCallback(async () => {
    const generation = tabGenerationRef.current
    try {
      await window.electronAPI.cancelAgentSwitch(tabId)
      if (mountedRef.current && generation === tabGenerationRef.current) void refresh()
    } catch {
      if (mountedRef.current && generation === tabGenerationRef.current) {
        localErrorRef.current = 'キャンセルの通信に失敗しました'
        setState((current) => ({ ...current, phase: 'error', reason: localErrorRef.current!, progress: null }))
        onPreparingChange(tabId, false)
      }
    }
  }, [tabId, onPreparingChange, refresh])

  const recoveryTriggerRef = useRef<HTMLButtonElement>(null)
  const closeRecovery = useCallback(() => {
    setRecoveryOpen(false)
    requestAnimationFrame(() => recoveryTriggerRef.current?.focus())
  }, [])
  const retryRecovery = useCallback((retryTarget: Agent) => { void switchAgent(retryTarget) }, [switchAgent])
  const disabled = !state.canSwitch || state.phase === 'preparing'
  const elapsed = state.progress ? Math.max(state.progress.elapsedMs, clock - state.progress.startedAt) : 0
  const newestMetrics = useMemo(() => [...metrics].reverse(), [metrics])
  // The ring receives rendererMs asynchronously after reset acknowledgement.
  // Prefer its matching entry over the state snapshot when available.
  const latestMetric = useMemo(() => {
    const matching = state.lastAttempt && newestMetrics.find((attempt) => attempt.startedAt === state.lastAttempt?.startedAt)
    return matching ?? state.lastAttempt ?? newestMetrics[0] ?? null
  }, [state.lastAttempt, newestMetrics])
  const successLabel = state.phase === 'idle' && !state.reason && state.lastAttempt?.outcome === 'success' ? `${labelFor(state.lastAttempt.to)}へ引き継ぎました` : null

  return <section className="agent-switch" aria-label="Agent handoff">
    <div className="agent-switch-main">
      <span className="agent-switch-label">{state.agent ? labelFor(state.agent) : '—'}</span><span className="agent-switch-arrow" aria-hidden="true">→</span>
      <label className="agent-switch-target"><span className="sr-only">引き継ぎ先</span><select value={target} onChange={(event) => setTarget(event.target.value as Agent)} disabled={disabled}>
        <option value="claude" disabled={state.agent === 'claude'}>Claude</option><option value="codex" disabled={state.agent === 'codex'}>Codex</option>
      </select></label>
      <button className="agent-switch-submit" type="button" onClick={() => void switchAgent()} disabled={disabled} title={disabled ? state.reason : undefined}>引き継ぐ</button>
      <span className="agent-switch-experimental">Experimental</span>
      <button className="agent-switch-history-toggle" type="button" onClick={() => setShowHistory((value) => !value)} aria-expanded={showHistory}>引き継ぎ内容</button>
    </div>
    {(state.phase === 'preparing' || state.reason || successLabel) && <div className="agent-switch-status" aria-live="polite">
      {state.phase === 'preparing' && state.progress ? <><span>{stageLabel[state.progress.stage]}（{duration(elapsed)}）</span><button type="button" onClick={() => void cancel()}>キャンセル</button></> : successLabel ? <span className="agent-switch-success">{successLabel}</span> : <span className={state.phase === 'error' ? 'agent-switch-error' : undefined}>{state.reason}</span>}
      {state.phase !== 'preparing' && state.recovery && <button type="button" className="agent-switch-recovery-open" ref={recoveryTriggerRef} onClick={() => setRecoveryOpen(true)}>切り替え先を確認</button>}
    </div>}
    {showHistory && <div className="agent-switch-history">
      <div className="agent-switch-context-header"><strong>今回引き継ぐ内容</strong><button type="button" onClick={() => void refreshContext()}>更新</button></div>
      {!context ? <p>引き継ぎ内容を読み込み中…</p> : !context.ready ? <p className="agent-switch-error">{context.reason || '引き継ぎ内容を準備中です。'}</p> : <>
        {(context.stats.truncated || context.stats.droppedTurns > 0) && <p className="agent-switch-context-warning">一部の会話が省略されています。</p>}
        <p className="agent-switch-context-stats">会話 {context.stats.turnCount} 件{context.stats.omittedReceipts ? ` ・ 自動受領 ${context.stats.omittedReceipts} 件を省略` : ''}{context.stats.retainedUnknown ? ' ・ 一部を保持' : ''}</p>
        <pre className="agent-switch-context-text">{context.text || '引き継ぎ可能な会話はまだありません。'}</pre>
      </>}
      <details><summary>以前の引き継ぎ</summary>{state.history.length === 0 ? <p>以前の引き継ぎはありません。</p> : state.history.map((entry, index) => <div className="agent-switch-history-entry" key={`${entry.agent}-${index}`}><strong>{labelFor(entry.agent)}</strong><pre>{entry.text}</pre></div>)}</details>
      {latestMetric && <details className="agent-switch-metrics"><summary>計測値</summary><AttemptDetails attempt={latestMetric} />{newestMetrics.filter((attempt) => attempt.startedAt !== latestMetric.startedAt).slice(0, 2).map((attempt) => <AttemptDetails key={attempt.startedAt} attempt={attempt} />)}</details>}
    </div>}
    {recoveryOpen && state.recovery && <AgentSwitchRecovery tabId={tabId} target={state.recovery.agent} onClose={closeRecovery} onRetry={retryRecovery} />}
  </section>
}
