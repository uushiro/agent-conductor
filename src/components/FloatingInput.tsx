import { useState, useRef, useEffect, useCallback } from 'react'
import { useSettings } from '../contexts/SettingsContext'
import { useLang, strings } from '../contexts/LangContext'

const STORAGE_KEY = 'terminal-input-bar-height'
const MIN_HEIGHT = 60
const MAX_HEIGHT = 400
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff'])

interface Props {
  activeTabId: string
  visible: boolean
  onClose: () => void
  onHeightChange?: (h: number) => void
  onToggle?: () => void
}

export function FloatingInput({ activeTabId, visible, onClose, onHeightChange, onToggle }: Props) {
  const { inputSendMode, inputSubmitMode } = useSettings()
  const { lang } = useLang()
  const t = strings[lang]
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<string[]>([])
  const [checkedMode, setCheckedMode] = useState(false)
  const checkedTabsRef = useRef(new Set<string>())
  const attachmentsByTabRef = useRef(new Map<string, string[]>())
  const previousTabRef = useRef(activeTabId)
  const [draftDestination, setDraftDestination] = useState<{ ready: boolean; agent: 'claude' | 'codex' | null; token: string; reason?: string } | null>(null)
  const [draftLoaded, setDraftLoaded] = useState(false)
  const editVersion = useRef(0)
  const editQueues = useRef(new Map<string, Promise<{ text: string; revision: number }>>())
  const sendingRef = useRef(false)
  const [draftSending, setDraftSending] = useState(false)
  const [draftError, setDraftError] = useState('')
  const tabGeneration = useRef(0)
  const [tuiMenuOpen, setTuiMenuOpen] = useState(false)
  const currentHeightRef = useRef(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved ? Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Number(saved))) : 100
  })
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const attachmentsRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const tuiMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const bar = barRef.current
    if (!bar) return
    const onDragOver = (e: DragEvent) => { e.preventDefault(); e.stopPropagation() }
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const files = Array.from(e.dataTransfer?.files ?? [])
      const paths = files.map((f) => window.electronAPI.getPathForFile(f)).filter(Boolean)
      if (paths.length > 0) setAttachments((prev) => [...new Set([...prev, ...paths])])
    }
    bar.addEventListener('dragover', onDragOver)
    bar.addEventListener('drop', onDrop)
    return () => {
      bar.removeEventListener('dragover', onDragOver)
      bar.removeEventListener('drop', onDrop)
    }
  }, [])

  useEffect(() => {
    if (!visible) { setTuiMenuOpen(false); return }
    if (!draftLoaded) return
    const timer = setTimeout(() => textareaRef.current?.focus(), 50)
    return () => clearTimeout(timer)
  }, [visible, activeTabId, draftLoaded])

  useEffect(() => {
    // Attachments remain renderer-local, but are keyed by stable logical tab.
    attachmentsByTabRef.current.set(previousTabRef.current, attachments)
    previousTabRef.current = activeTabId
    setAttachments(attachmentsByTabRef.current.get(activeTabId) ?? [])
  }, [activeTabId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    attachmentsByTabRef.current.set(previousTabRef.current, attachments)
  }, [attachments])

  useEffect(() => {
    const epoch = ++tabGeneration.current
    setTuiMenuOpen(false); setCheckedMode(checkedTabsRef.current.has(activeTabId)); setDraftDestination(null); setDraftError(''); setDraftSending(false); setDraftLoaded(false); sendingRef.current = false
    void Promise.all([(editQueues.current.get(activeTabId) ?? Promise.resolve()).catch(() => undefined).then(() => window.electronAPI.getHandoffDraft(activeTabId)), window.electronAPI.getHandoffDraftDestination(activeTabId), window.electronAPI.getAgentSwitchState(activeTabId)]).then(([draft, destination, handoff]) => {
      if (epoch !== tabGeneration.current) return
      const observed = handoff.phase === 'preparing' || !!handoff.recovery || !!handoff.lastAttempt || handoff.history.length > 0; if (observed) checkedTabsRef.current.add(activeTabId); setCheckedMode(observed || checkedTabsRef.current.has(activeTabId)); setText(draft.text); setDraftLoaded(true); setDraftDestination(destination)
    }).catch(() => { if (epoch === tabGeneration.current) setDraftError('下書きを読み込めませんでした。') })
    const timer = window.setInterval(() => void Promise.all([window.electronAPI.getHandoffDraftDestination(activeTabId), window.electronAPI.getAgentSwitchState(activeTabId)]).then(([d, handoff]) => { if (epoch !== tabGeneration.current) return; const observed = handoff.phase === 'preparing' || !!handoff.recovery || !!handoff.lastAttempt || handoff.history.length > 0; if (observed) checkedTabsRef.current.add(activeTabId); setCheckedMode(observed || checkedTabsRef.current.has(activeTabId)); setDraftDestination(d) }).catch(() => undefined), 500)
    return () => { ++tabGeneration.current; window.clearInterval(timer) }
  }, [activeTabId])

  useEffect(() => {
    if (!tuiMenuOpen) return
    const handlePointerDown = (e: MouseEvent) => {
      if (!tuiMenuRef.current?.contains(e.target as Node)) setTuiMenuOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [tuiMenuOpen])

  useEffect(() => {
    onHeightChange?.(currentHeightRef.current())
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // チップが増えたとき、必要なら高さを自動拡張
  useEffect(() => {
    if (!attachmentsRef.current) return
    const chipsH = attachmentsRef.current.offsetHeight
    const minNeeded = Math.min(MAX_HEIGHT, 60 + chipsH + 10)
    if (currentHeightRef.current() < minNeeded) {
      currentHeightRef.current = () => minNeeded
      onHeightChange?.(minNeeded)
    }
  }, [attachments]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = currentHeightRef.current()
    const onMove = (me: MouseEvent) => {
      const next = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startH - (me.clientY - startY)))
      currentHeightRef.current = () => next
      onHeightChange?.(next)
      localStorage.setItem(STORAGE_KEY, String(next))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'ns-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  const queueDraft = (value: string) => {
    const queued = (editQueues.current.get(activeTabId) ?? Promise.resolve()).catch(() => undefined).then(() => window.electronAPI.setHandoffDraft(activeTabId, value))
    editQueues.current.set(activeTabId, queued)
    return queued
  }
  const editText = (value: string) => {
    ++editVersion.current; setText(value); setDraftError('')
    const epoch = tabGeneration.current
    void queueDraft(value).catch(() => { if (epoch === tabGeneration.current) setDraftError('下書きを保存できませんでした。') })
  }

  const sendText = async () => {
    if (!draftLoaded || sendingRef.current || (!text.trim() && attachments.length === 0) || !activeTabId) return
    const epoch = tabGeneration.current, version = editVersion.current
    sendingRef.current = true; setDraftSending(true)
    try {
    const fresh = await window.electronAPI.getAgentSwitchState(activeTabId)
    if (epoch !== tabGeneration.current || version !== editVersion.current) return
    const nowChecked = checkedMode || fresh.phase === 'preparing' || !!fresh.recovery || !!fresh.lastAttempt || fresh.history.length > 0
    if (nowChecked) {
      checkedTabsRef.current.add(activeTabId); setCheckedMode(true)
      if (attachments.length > 0) { setDraftError('添付は保持しています。切り替え後の添付送信は端末から行ってください。'); return }
      if (!draftDestination?.ready) { setDraftError('入力待ちになってから送信してください。下書きは保持しています。'); return }
      const token = draftDestination.token
      const draft = await (editQueues.current.get(activeTabId) ?? window.electronAPI.getHandoffDraft(activeTabId))
      if (epoch !== tabGeneration.current || version !== editVersion.current) return
      if (draft.text !== text) { setDraftError('下書きの保存を確認できませんでした。内容を確認してください。'); return }
      const submission = window.electronAPI.submitHandoffDraft(activeTabId, draft.revision, token, inputSubmitMode === 'direct')
      // Returning to this tab waits for an in-flight submission before loading
      // its draft, so a stale read cannot revive already-sent text.
      editQueues.current.set(activeTabId, submission.then(result => result.ok && result.draft ? result.draft : draft, () => draft))
      const result = await submission
      if (result.ok && result.draft) editQueues.current.set(activeTabId, Promise.resolve(result.draft))
      if (epoch !== tabGeneration.current) return
      if (result.ok) { setText(''); setDraftError(''); setTimeout(() => textareaRef.current?.focus(), 0) }
      else setDraftError(result.error || '送信できませんでした。下書きは保持しています。')
      return
    }
    if ((!text.trim() && attachments.length === 0) || !activeTabId) return

    const sendLegacyInput = (data: string) => window.electronAPI.sendTerminalInput(activeTabId, data, true)
    const hasAttachments = attachments.length > 0

    if (text && hasAttachments) {
      // テキストとファイルパスを分けて送信する。
      // まとめて送ると Claude Code がファイルパスを attachment として認識しない場合がある。
      // 1. テキスト部分を送信
      if (text.includes('\n')) {
        sendLegacyInput( '\x1b[200~' + text + '\x1b[201~')
      } else {
        sendLegacyInput( text)
      }
      // 2. ファイルパスを別の bracket paste で追送
      const filePart = '\n' + attachments.join('\n')
      setTimeout(() => {
        sendLegacyInput( '\x1b[200~' + filePart + '\x1b[201~')
      }, 150)
    } else {
      // テキストのみ、またはファイルのみ
      const filePart = hasAttachments ? '\n' + attachments.join('\n') : ''
      const fullText = text + filePart
      if (fullText.includes('\n')) {
        sendLegacyInput( '\x1b[200~' + fullText + '\x1b[201~')
      } else {
        sendLegacyInput( fullText)
      }
    }

    setText('')
    void queueDraft('').catch(() => undefined)
    setAttachments([])
    if (inputSubmitMode === 'direct') {
      if (hasAttachments) {
        // 画像UIが確実に出てから dismiss → submit
        // 1回目: 画像UIをdismiss（十分な余裕を持たせる）
        setTimeout(() => {
          sendLegacyInput( '\r')
          // 2回目: dismissが完了してからsubmit
          setTimeout(() => {
            sendLegacyInput( '\r')
          }, 1000)
        }, 800)
      } else {
        // 改行ありのブラケットペーストはClaude Codeの処理を待つ
        const delay = text.includes('\n') ? 400 : 80
        setTimeout(() => {
          sendLegacyInput( '\r')
        }, delay)
      }
    }
    setTimeout(() => textareaRef.current?.focus(), 30)
    } catch { if (epoch === tabGeneration.current) setDraftError('送信結果を確認できませんでした。会話を確認してから再試行してください。') }
    finally { if (epoch === tabGeneration.current) { sendingRef.current = false; setDraftSending(false) } }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      if (tuiMenuOpen) {
        e.preventDefault()
        setTuiMenuOpen(false)
        return
      }
      onClose()
      return
    }
    if (e.nativeEvent.isComposing) return

    const hasNoModifiers = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
    const canForwardTuiKey = text.length === 0 && attachments.length === 0 && hasNoModifiers
    const tuiKeySequence = e.key === 'ArrowUp'
      ? '\x1b[A'
      : e.key === 'ArrowDown'
      ? '\x1b[B'
      : e.key === 'Enter'
      ? '\r'
      : null

    if (canForwardTuiKey && tuiKeySequence) {
      e.preventDefault()
      window.electronAPI.sendTerminalInput(activeTabId, tuiKeySequence)
      return
    }

    if (inputSendMode === 'enter' && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendText()
      return
    }
    if (inputSendMode === 'cmd-enter' && e.key === 'Enter' && e.metaKey) {
      e.preventDefault()
      sendText()
      return
    }
  }

  const handleAttach = useCallback(async () => {
    const owner = activeTabId, epoch = tabGeneration.current
    const files = await window.electronAPI.openFileDialog()
    if (files.length > 0 && epoch !== tabGeneration.current) {
      attachmentsByTabRef.current.set(owner, [...new Set([...(attachmentsByTabRef.current.get(owner) ?? []), ...files])]); return
    }
    if (files.length > 0) {
      setAttachments((prev) => [...new Set([...prev, ...files])])
    }
  }, [activeTabId])

  const sendTuiKey = useCallback((sequence: string) => {
    window.electronAPI.sendTerminalInput(activeTabId, sequence)
    setTimeout(() => textareaRef.current?.focus(), 0)
  }, [activeTabId])

  const placeholder =
    inputSendMode === 'enter'
      ? t.inputPlaceholderEnter
      : inputSendMode === 'cmd-enter'
      ? t.inputPlaceholderCmdEnter
      : t.inputPlaceholderButton

  return (
    <>
      <div ref={barRef} className="terminal-input-bar">
        <div className="terminal-input-resize-handle" onMouseDown={handleResizeMouseDown} />
        <div className="terminal-input-inner">
          <div ref={tuiMenuRef} className="terminal-tui-menu">
            <button
              type="button"
              className={`terminal-tui-menu-trigger${tuiMenuOpen ? ' terminal-tui-menu-trigger--open' : ''}`}
              title="TUI操作（入力欄が空なら ↑ ↓ Enter をキーボードから操作できます）"
              aria-label="TUI操作メニュー"
              aria-expanded={tuiMenuOpen}
              onClick={() => setTuiMenuOpen((open) => !open)}
            >⌨</button>
            {tuiMenuOpen && (
              <div className="terminal-tui-menu-popover" role="group" aria-label="ターミナルUIの操作">
                <span className="terminal-tui-menu-label">TUI操作</span>
                <button
                  type="button"
                  title="ターミナルへ上矢印キーを送る"
                  onClick={() => sendTuiKey('\x1b[A')}
                >↑</button>
                <button
                  type="button"
                  title="ターミナルへ下矢印キーを送る"
                  onClick={() => sendTuiKey('\x1b[B')}
                >↓</button>
                <button
                  type="button"
                  title="ターミナルへEnterキーを送る"
                  onClick={() => sendTuiKey('\r')}
                >決定</button>
                <span className="terminal-tui-menu-hint">空欄なら ↑ ↓ Enter</span>
              </div>
            )}
          </div>
          <div
            className="terminal-input-field"
            data-has-attachments={attachments.length > 0 || undefined}
          >
            <textarea
              ref={textareaRef}
              className="terminal-input-textarea"
              value={text}
              disabled={!draftLoaded || draftSending}
              maxLength={30000}
              onChange={(e) => editText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              onPaste={async (e) => {
                const items = Array.from(e.clipboardData.items)
                const imageItem = items.find((i) => i.type.startsWith('image/'))
                if (!imageItem) return
                e.preventDefault()
                const owner = activeTabId, epoch = tabGeneration.current
                const tmpPath = `/tmp/paste-${Date.now()}.png`
                const ok = await window.electronAPI.saveClipboardImage(tmpPath)
                if (ok && epoch !== tabGeneration.current) { attachmentsByTabRef.current.set(owner, [...new Set([...(attachmentsByTabRef.current.get(owner) ?? []), tmpPath])]); return }
                if (ok) setAttachments((prev) => [...new Set([...prev, tmpPath])])
              }}
            />
            {checkedMode && draftDestination && <span className="handoff-composer-target">{draftDestination.ready ? `${inputSubmitMode === 'direct' ? '送信先' : '入力先'}：${draftDestination.agent === 'claude' ? 'Claude' : draftDestination.agent === 'codex' ? 'Codex' : '—'}` : (draftDestination.reason || '送信先を確認中')}</span>}
            {draftError && <span className="handoff-composer-error" role="alert">{draftError}</span>}
            {attachments.length > 0 && (
              <div ref={attachmentsRef} className="terminal-input-attachments">
                {attachments.map((f) => {
                  const ext = f.slice(f.lastIndexOf('.')).toLowerCase()
                  const isImage = IMAGE_EXTS.has(ext)
                  return (
                    <span key={f} className="terminal-input-chip">
                      {isImage ? (
                      <svg className="terminal-input-chip-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <rect x="0.5" y="0.5" width="11" height="11" rx="1.5" stroke="currentColor" strokeWidth="1"/>
                        <circle cx="3.5" cy="3.5" r="1" fill="currentColor"/>
                        <path d="M1 9L4 6L6 8L8 5.5L11 9" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
                      </svg>
                    ) : (
                      <svg className="terminal-input-chip-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M2 1h6l2 2v8H2V1z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
                        <path d="M8 1v2h2" stroke="currentColor" strokeWidth="1"/>
                      </svg>
                    )}
                      <span className="terminal-input-chip-name">{f.split('/').pop()}</span>
                      <button
                        className="terminal-input-chip-remove"
                        onClick={() => setAttachments((prev) => prev.filter((p) => p !== f))}
                      >×</button>
                    </span>
                  )
                })}
              </div>
            )}
            <button className="terminal-input-attach" onClick={handleAttach} title="ファイルを添付">
              📎
            </button>
            {inputSendMode === 'button' && (
              <button
                className="terminal-input-send"
                onClick={sendText}
                disabled={!draftLoaded || draftSending || (!text.trim() && attachments.length === 0)}
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
