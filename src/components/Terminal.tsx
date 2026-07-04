import { useEffect, useRef, type CSSProperties } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface TerminalProps {
  tabId: string
  /** Shown in any pane (single view: the active tab) */
  visible: boolean
  /** This pane is the focused one (only meaningful in split view) */
  focused: boolean
  fontSize: number
  /** Pane geometry override (split view): e.g. { right: '50%' } / { left: '50%' } */
  paneStyle?: CSSProperties
  /** Called when the user interacts with this terminal (focus the pane) */
  onFocusRequest?: () => void
}

// xterm の SelectionService#selectionText は、複数行ドラッグの終点が
// 次の行の先頭（column 0）に来た場合でも「その行」を選択範囲の一部として
// 扱い、空文字列を末尾に push してしまう（isWrapped でない行として区切り文字
// \n を伴う）。結果として「最終行の下にわずかに入り込んだだけ」でコピー結果の
// 末尾に意図しない空行（余分な改行）が付与される。
// これは xterm.js 側の既知の挙動で、実際に折り返し行(isWrapped)は
// translateBufferLineToString 側で正しく連結されているため（本アプリ含め
// getSelection() をそのまま使うだけでは折り返し改行の混入は発生しない）、
// 余分な改行の主因はこの「終端オーバーシュートによる末尾の空行」である。
// 意図的に空行を選択したケース(複数の空行が続く末尾選択)まで壊さないよう、
// 末尾の改行は1つだけ取り除く。
function stripTrailingSelectionNewline(text: string): string {
  return text.replace(/\r?\n$/, '')
}

export function Terminal({ tabId, visible, focused, fontSize, paneStyle, onFocusRequest }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const term = new XTerm({
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        cursorAccent: '#0d1117',
        selectionBackground: '#264f78',
        selectionInactiveBackground: '#264f78',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39d353',
        white: '#b1bac4',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d364',
        brightWhite: '#f0f6fc',
      },
      fontSize: fontSize,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      macOptionClickForcesSelection: true,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)

    term.open(containerRef.current)
    fitAddon.fit()

    // .xterm-screen のキャプチャ段階で altKey=true の合成イベントを発火し
    // xterm の shouldForceSelection(= altKey && macOptionClickForcesSelection) を通過させる
    let synthesizing = false
    const xtermScreen = containerRef.current.querySelector('.xterm-screen') as HTMLElement | null
    const handleForceSelection = (e: MouseEvent) => {
      if (e.button !== 0 || e.altKey || synthesizing) return
      term.focus()
      // PTYがマウスレポーティングを使っている場合はstopPropagationをスキップ
      // (Claude Code TUIのタスクツリー等がクリックを受け取れるようにするため)
      if (term.modes.mouseTrackingMode === 'none') {
        e.stopPropagation()
      }
      synthesizing = true
      e.target?.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, view: window,
        clientX: e.clientX, clientY: e.clientY,
        button: 0, buttons: 1, altKey: true,
        detail: e.detail,
      }))
      synthesizing = false
    }
    if (xtermScreen) {
      xtermScreen.addEventListener('mousedown', handleForceSelection, true)
    }

    // ドラッグ中に選択テキストをリアルタイムに保存
    let lastSelText = ''
    term.onSelectionChange(() => {
      const s = term.getSelection()
      if (s) lastSelText = s
    })

    terminalRef.current = term
    fitAddonRef.current = fitAddon

    // Delete selected text in bulk (selection + Backspace/Delete)
    // Also pass through tab-switching shortcuts so they bubble to document handlers
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true

      // Pass through tab-switching shortcuts (xterm would otherwise swallow them)
      const isTabSwitch =
        (ev.ctrlKey && ev.key === 'Tab') || // Ctrl+Tab / Ctrl+Shift+Tab
        (ev.metaKey && ev.key >= '1' && ev.key <= '9') || // Cmd+1-9
        (ev.metaKey && ev.altKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) || // Cmd+Option+←/→
        (ev.metaKey && ev.key === 'w') || // Cmd+W
        (ev.metaKey && ev.key === 't') || // Cmd+T
        (ev.metaKey && (ev.key === '\\' || ev.key === '¥' || ev.key === '|')) // Cmd+\ (split toggle) / Cmd+Shift+\ (split swap, Shift+\='|')
      if (isTabSwitch) {
        return false // xtermに処理させず、元のイベントのバブリングでdocumentハンドラに届ける
      }

      if ((ev.key === 'Backspace' || ev.key === 'Delete') && term.hasSelection()) {
        const selected = term.getSelection()
        // Strip newlines (wrapped lines) and count characters
        const count = selected.replace(/\r?\n/g, '').length
        if (count > 0) {
          // Backspace (\x7f) repeated for the selection length
          window.electronAPI.sendTerminalInput(tabId, '\x7f'.repeat(count))
        }
        term.clearSelection()
        return false
      }
      return true
    })

    // Relay keyboard input → main process (with tabId)
    term.onData((data) => {
      window.electronAPI.sendTerminalInput(tabId, data)
    })

    // Receive pty output → render (filter by tabId)
    const handler = (incomingTabId: string, data: string) => {
      if (incomingTabId === tabId) {
        term.write(data)
      }
    }
    const removeDataListener = window.electronAPI.onTerminalData(handler)

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit()
        window.electronAPI.resizeTerminal(tabId, term.cols, term.rows)
      } catch {
        // ignore
      }
    })
    resizeObserver.observe(containerRef.current)

    const handleMouseDown = () => term.focus()
    const handleMouseUp = () => {
      // document レベルの mouseup（xterm の finalize）完了後に実行
      setTimeout(() => {
        // getSelection() が残っていれば優先、なければ onSelectionChange で捕捉した値を使う
        const sel = term.getSelection() || lastSelText
        lastSelText = ''
        if (sel) window.electronAPI.copyToClipboard(stripTrailingSelectionNewline(sel))
      }, 0)
    }
    containerRef.current.addEventListener('mousedown', handleMouseDown)
    containerRef.current.addEventListener('mouseup', handleMouseUp)

    return () => {
      removeDataListener()
      resizeObserver.disconnect()
      containerRef.current?.removeEventListener('mousedown', handleMouseDown)
      containerRef.current?.removeEventListener('mouseup', handleMouseUp)
      if (xtermScreen) xtermScreen.removeEventListener('mousedown', handleForceSelection, true)
      term.dispose()
    }
  }, [tabId])

  // Update font size dynamically
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.fontSize = fontSize
      fitAddonRef.current?.fit()
    }
  }, [fontSize])

  // Re-fit when becoming visible (container may have resized while hidden)
  useEffect(() => {
    if (visible && fitAddonRef.current && terminalRef.current) {
      // Small delay to ensure the container is visible before fitting
      const timer = setTimeout(() => {
        try {
          fitAddonRef.current?.fit()
          const term = terminalRef.current
          if (term) {
            window.electronAPI.resizeTerminal(tabId, term.cols, term.rows)
          }
        } catch {
          // ignore
        }
      }, 10)
      return () => clearTimeout(timer)
    }
  }, [visible, tabId])

  return (
    <div
      ref={containerRef}
      data-tab-id={tabId}
      className={`terminal-container${focused ? ' terminal-container--focused' : ''}`}
      style={{ display: visible ? undefined : 'none', userSelect: 'none', WebkitUserSelect: 'none', ...paneStyle }}
      onMouseDown={onFocusRequest}
    />
  )
}
