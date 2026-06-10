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
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)

    term.open(containerRef.current)
    fitAddon.fit()

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
        (ev.metaKey && (ev.key === '\\' || ev.key === '¥')) // Cmd+\ (split toggle, JIS: ¥)
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

    return () => {
      removeDataListener()
      resizeObserver.disconnect()
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
      style={{ display: visible ? undefined : 'none', ...paneStyle }}
      onMouseDown={onFocusRequest}
    />
  )
}
