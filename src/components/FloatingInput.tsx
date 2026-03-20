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
  const currentHeightRef = useRef(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved ? Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Number(saved))) : 100
  })
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const attachmentsRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)

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
    if (visible) {
      setTimeout(() => textareaRef.current?.focus(), 50)
    }
  }, [visible])

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

  const sendText = useCallback(async () => {
    if ((!text.trim() && attachments.length === 0) || !activeTabId) return

    // 全ファイル（画像含む）をパスとしてメッセージに追記
    const filePart = attachments.length > 0 ? '\n' + attachments.join('\n') : ''
    const fullText = text + filePart
    // 改行を含む場合はブラケットペーストモードで囲む（途中の\nがEnterとして実行されるのを防ぐ）
    if (fullText.includes('\n')) {
      window.electronAPI.sendTerminalInput(activeTabId, '\x1b[200~' + fullText + '\x1b[201~')
    } else {
      window.electronAPI.sendTerminalInput(activeTabId, fullText)
    }
    const hasAttachments = attachments.length > 0
    setText('')
    setAttachments([])
    if (inputSubmitMode === 'direct') {
      if (hasAttachments) {
        // 画像UIが確実に出てから dismiss → submit
        // 1回目: 画像UIをdismiss（十分な余裕を持たせる）
        setTimeout(() => {
          window.electronAPI.sendTerminalInput(activeTabId, '\r')
          // 2回目: dismissが完了してからsubmit
          setTimeout(() => {
            window.electronAPI.sendTerminalInput(activeTabId, '\r')
          }, 1000)
        }, 800)
      } else {
        // 改行ありのブラケットペーストはClaude Codeの処理を待つ
        const delay = fullText.includes('\n') ? 400 : 80
        setTimeout(() => {
          window.electronAPI.sendTerminalInput(activeTabId, '\r')
        }, delay)
      }
    }
    setTimeout(() => textareaRef.current?.focus(), 30)
  }, [text, attachments, activeTabId, inputSubmitMode])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      onClose()
      return
    }
    if (e.nativeEvent.isComposing) return
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
    const files = await window.electronAPI.openFileDialog()
    if (files.length > 0) {
      setAttachments((prev) => [...new Set([...prev, ...files])])
    }
  }, [])

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
          <div
            className="terminal-input-field"
            data-has-attachments={attachments.length > 0 || undefined}
          >
            <textarea
              ref={textareaRef}
              className="terminal-input-textarea"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              onPaste={async (e) => {
                const items = Array.from(e.clipboardData.items)
                const imageItem = items.find((i) => i.type.startsWith('image/'))
                if (!imageItem) return
                e.preventDefault()
                const tmpPath = `/tmp/paste-${Date.now()}.png`
                const ok = await window.electronAPI.saveClipboardImage(tmpPath)
                if (ok) setAttachments((prev) => [...new Set([...prev, tmpPath])])
              }}
            />
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
                disabled={!text.trim() && attachments.length === 0}
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
