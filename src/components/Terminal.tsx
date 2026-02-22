import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface TerminalProps {
  tabId: string
  isActive: boolean
}

export function Terminal({ tabId, isActive }: TerminalProps) {
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
      fontSize: 14,
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

  // Re-fit when becoming active (container may have resized while hidden)
  useEffect(() => {
    if (isActive && fitAddonRef.current && terminalRef.current) {
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
  }, [isActive, tabId])

  return (
    <div
      ref={containerRef}
      className="terminal-container"
      style={{ display: isActive ? undefined : 'none' }}
    />
  )
}
