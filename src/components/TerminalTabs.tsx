import { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle, type CSSProperties } from 'react'
import { Terminal } from './Terminal'
import { useSettings } from '../contexts/SettingsContext'
import { useLang, strings } from '../contexts/LangContext'

export interface TerminalTabsHandle {
  sendToNewTab: (prompt: string, agent: 'claude' | 'gemini' | 'codex') => void
  resumeSession: (sessionId: string) => void
}

// In-tab worker agent reported via [[AGENT: label :: model :: started|done]] markers
interface ActiveAgent {
  label: string
  model: string
  status: 'started' | 'done'
}

interface Tab {
  id: string
  issue: string
  detail: string
  customIssue: boolean
  resuming: boolean
  model: string | null
  activeAgents: ActiveAgent[]
}

interface ClosedEntry {
  issue: string
  cwd: string
  claudeSessionId: string | null
  agent: 'claude' | 'gemini' | 'codex'
  closedAt: number
  model: string | null
}

// Claude model badge definitions (color dot + 1-letter abbreviation on tabs).
// Detection is spawn-command based (main.ts parses --model from the launch args);
// non-claude tabs and unknown models have model=null → no badge.
type ClaudeModel = 'fable' | 'opus' | 'sonnet' | 'haiku'
const CLAUDE_MODELS: Record<ClaudeModel, { letter: string; color: string; full: string }> = {
  fable: { letter: 'F', color: '#a371f7', full: 'Fable 5' },
  opus: { letter: 'O', color: '#d29922', full: 'Opus' },
  sonnet: { letter: 'S', color: '#58a6ff', full: 'Sonnet' },
  haiku: { letter: 'H', color: '#3fb950', full: 'Haiku' },
}
// Models offered in the "+" agent menu (opus is detected if launched manually, but not offered)
const MENU_MODELS: ClaudeModel[] = ['fable', 'sonnet', 'haiku']

function getModelBadge(model: string | null): { letter: string; color: string; full: string } | null {
  if (!model) return null
  // Strip the inherited-model suffix added by the marker hook (e.g. "fable (継承)")
  const key = model.replace(/\s*\(継承\)\s*$/, '')
  return CLAUDE_MODELS[key as ClaudeModel] ?? null
}

interface Props {
  activeTabId: string
  panes: [string, string | null]
  splitPair: [string, string] | null
  focusedPane: 0 | 1
  onActiveTabChange: (tabId: string) => void
  onAddToSplit: (tabId: string) => void
  onRemoveFromSplit: (tabId: string) => void
  onSwapSplit: () => void
  onCloseRightPane: () => void
  onTabRemoved: (tabId: string, fallbackId: string) => void
}

export const TerminalTabs = forwardRef<TerminalTabsHandle, Props>(function TerminalTabs({ activeTabId, panes, splitPair, focusedPane, onActiveTabChange, onAddToSplit, onRemoveFromSplit, onSwapSplit, onCloseRightPane, onTabRemoved }, ref) {
  const { fontSize, defaultAgent } = useSettings()
  const { lang } = useLang()
  const t = strings[lang]
  const [tabs, setTabs] = useState<Tab[]>([])
  const [editingTabId, setEditingTabId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [confirmClose, setConfirmClose] = useState<{ tabId: string; issue: string } | null>(null)
  const [closedHistory, setClosedHistory] = useState<ClosedEntry[]>([])
  const [showRestoreMenu, setShowRestoreMenu] = useState(false)
  const [showAgentMenu, setShowAgentMenu] = useState(false)
  const [dragOverIdx, setDragOverIdx] = useState<number>(-1)
  const [dragSrcIdxState, setDragSrcIdxState] = useState<number>(-1)
  // Split view: pane divider position (% width of the left pane)
  const [splitRatio, setSplitRatio] = useState(() => {
    const saved = Number(localStorage.getItem('pane-split-ratio'))
    return saved >= 20 && saved <= 80 ? saved : 50
  })
  const splitRatioRef = useRef(splitRatio)
  splitRatioRef.current = splitRatio
  // Tab context menu (right-click)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tabId: string } | null>(null)
  // Popover listing in-tab worker agents (opened by clicking the model badge)
  // Agent popover: anchored to the clicked tab (fixed coords computed on open,
  // same pattern as .tab-context-menu). x/y = viewport position of the panel.
  const [agentPopover, setAgentPopover] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const dragSrcIdx = useRef<number>(-1)
  const dragOverIdxRef = useRef<number>(-1)
  const editInputRef = useRef<HTMLInputElement>(null)
  const restoreMenuRef = useRef<HTMLDivElement>(null)
  const agentMenuRef = useRef<HTMLDivElement>(null)
  const initialized = useRef(false)
  const tabsRef = useRef<Tab[]>([])

  // Restore session or create first tab on mount
  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    restoreOrInit()
  }, [])

  async function restoreOrInit() {
    // 開発環境では毎回まっさらなclaudeタブを開く
    if (import.meta.env.DEV) {
      createTab()
      return
    }
    const session = await window.electronAPI.loadSession()
    if (session && session.tabs.length > 0) {
      const restored: Tab[] = []
      const claudeResumes: Array<{ tabId: string; sessionId: string | null; model: string | null }> = []
      const geminiResumes: Array<{ tabId: string }> = []
      const codexResumes: Array<{ tabId: string }> = []
      for (const saved of session.tabs) {
        const tabId = await window.electronAPI.createTerminal(
          saved.cwd,
          saved.hadClaude ? saved.claudeSessionId ?? undefined : undefined
        )
        if (saved.issue) {
          await window.electronAPI.setTerminalIssue(tabId, saved.issue)
        }
        if (saved.hadClaude) {
          claudeResumes.push({ tabId, sessionId: saved.claudeSessionId, model: saved.model ?? null })
        } else if (saved.hadGemini) {
          geminiResumes.push({ tabId })
        } else if (saved.hadCodex) {
          codexResumes.push({ tabId })
        }
        const willResume = saved.hadClaude || saved.hadGemini || saved.hadCodex
        restored.push({
          id: tabId,
          issue: saved.issue,
          detail: willResume ? 'Resuming...' : '',
          customIssue: !!saved.issue,
          resuming: willResume,
          model: saved.hadClaude ? saved.model ?? null : null,
          activeAgents: [],
        })
      }
      setTabs(restored)
      const activeIdx = Math.min(session.activeIndex, restored.length - 1)
      onActiveTabChange(restored[activeIdx]?.id || restored[0]?.id || '')

      // Auto-resume Claude tabs (3000ms stagger to prevent cross-tab session mixing)
      claudeResumes.forEach(({ tabId, sessionId, model }, i) => {
        setTimeout(() => {
          const modelFlag = model ? ` --model ${model}` : ''
          const cmd = sessionId ? `claude${modelFlag} --resume ${sessionId}\r` : `claude${modelFlag}\r`
          window.electronAPI.sendTerminalInput(tabId, cmd)
        }, 1000 + i * 3000)
      })

      // Auto-resume Gemini tabs (after all Claude resumes)
      const claudeOffset = 1000 + claudeResumes.length * 3000
      geminiResumes.forEach(({ tabId }, i) => {
        setTimeout(() => {
          window.electronAPI.sendTerminalInput(tabId, 'gemini --resume latest\r')
        }, claudeOffset + i * 2000)
      })

      // Auto-resume Codex tabs (after all Gemini resumes)
      const geminiOffset = claudeOffset + geminiResumes.length * 2000
      codexResumes.forEach(({ tabId }, i) => {
        setTimeout(() => {
          window.electronAPI.sendTerminalInput(tabId, 'codex\r')
        }, geminiOffset + i * 2000)
      })
    } else {
      createTab()
    }
  }

  // Keep tabsRef in sync so polling can read current tabs without setTabs-for-reading
  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])

  // Poll tab titles from main process + clear resuming state via main process isResuming flag
  useEffect(() => {
    const interval = setInterval(() => {
      // Fetch isResuming from main process in parallel with titles
      window.electronAPI.listTerminalInfo().then((infos) => {
        const resumingSet = new Set(infos.filter((i) => i.isResuming).map((i) => i.id))
        for (const tab of tabsRef.current) {
          window.electronAPI.getTerminalTitle(tab.id).then(({ issue, detail, model, activeAgents }) => {
            setTabs((current) =>
              current.map((t) => {
                if (t.id !== tab.id) return t
                const stillResuming = resumingSet.has(t.id)
                const newIssue = t.customIssue ? t.issue : issue
                const newDetail = stillResuming ? 'Resuming...' : detail
                const agents = activeAgents ?? []
                const agentsChanged = JSON.stringify(agents) !== JSON.stringify(t.activeAgents)
                if (newIssue === t.issue && newDetail === t.detail && stillResuming === t.resuming && model === t.model && !agentsChanged) return t
                return { ...t, issue: newIssue, detail: newDetail, resuming: stillResuming, model, activeAgents: agents }
              })
            )
          })
        }
      })
    }, 2000)
    return () => clearInterval(interval)
  }, [])

  // Poll closed history
  useEffect(() => {
    const fetch = () => {
      window.electronAPI.getClosedHistory().then(setClosedHistory)
    }
    fetch()
    const interval = setInterval(fetch, 3000)
    return () => clearInterval(interval)
  }, [])

  // Focus input when editing starts
  useEffect(() => {
    if (editingTabId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingTabId])

  // Close restore menu when clicking outside
  useEffect(() => {
    if (!showRestoreMenu) return
    const handler = (e: MouseEvent) => {
      if (restoreMenuRef.current && !restoreMenuRef.current.contains(e.target as Node)) {
        setShowRestoreMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showRestoreMenu])

  // Persist split ratio
  useEffect(() => {
    localStorage.setItem('pane-split-ratio', String(splitRatio))
  }, [splitRatio])

  // Capsule adjacency (Chrome-style): keep the split pair's tabs next to each
  // other in the tab bar (pair[0] = left pane on the left). Runs on pair
  // formation AND on any tabs change, so a drag-drop that would land between
  // the pair self-heals back to adjacency.
  useEffect(() => {
    if (!splitPair) return
    const i0 = tabs.findIndex((t) => t.id === splitPair[0])
    const i1 = tabs.findIndex((t) => t.id === splitPair[1])
    if (i0 === -1 || i1 === -1 || i1 === i0 + 1) return
    const moved = tabs[i1]
    const next = tabs.filter((t) => t.id !== splitPair[1])
    next.splice(next.findIndex((t) => t.id === splitPair[0]) + 1, 0, moved)
    window.electronAPI.reorderTerminals(next.map((t) => t.id))
    setTabs(next)
  }, [splitPair, tabs])

  // Close context menu when clicking outside / pressing Escape
  useEffect(() => {
    if (!ctxMenu) return
    const onMouseDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement
      if (!el.closest('.tab-context-menu')) setCtxMenu(null)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [ctxMenu])

  // Close agent popover when clicking outside / pressing Escape
  useEffect(() => {
    if (!agentPopover) return
    const onMouseDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement
      if (!el.closest('.tab-agent-badge-area')) setAgentPopover(null)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAgentPopover(null)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [agentPopover])

  // Pane divider drag (split view resize)
  const handlePaneResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const rect = contentRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    const onMove = (me: MouseEvent) => {
      const ratio = ((me.clientX - rect.left) / rect.width) * 100
      setSplitRatio(Math.max(20, Math.min(80, ratio)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  // Close agent menu when clicking outside
  useEffect(() => {
    if (!showAgentMenu) return
    const handler = (e: MouseEvent) => {
      if (agentMenuRef.current && !agentMenuRef.current.contains(e.target as Node)) {
        setShowAgentMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showAgentMenu])

  // ref to always-current doCloseTab / closeTab (used in keydown handler below)
  const doCloseTabRef = useRef<(tabId: string) => void>(() => {})
  const closeTabRef = useRef<(tabId: string) => void>(() => {})
  const confirmCloseRef = useRef<{ tabId: string; issue: string } | null>(null)
  confirmCloseRef.current = confirmClose

  // Escape cancels / Enter confirms the close dialog
  useEffect(() => {
    if (!confirmClose) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        setConfirmClose(null)
      }
      if (e.key === 'Enter' || (e.metaKey && e.key === 'w')) {
        e.preventDefault()
        e.stopImmediatePropagation()
        doCloseTabRef.current(confirmClose.tabId)
        setConfirmClose(null)
      }
    }
    document.addEventListener('keydown', handler, true) // capture phase: fires before main handler
    return () => document.removeEventListener('keydown', handler, true)
  }, [confirmClose])

  const createTab = useCallback(async (agent: 'claude' | 'gemini' | 'codex' | 'terminal' = defaultAgent, initialPrompt?: string, model?: ClaudeModel) => {
    const tabId = await window.electronAPI.createTerminal()
    setTabs((prev) => [
      ...prev,
      { id: tabId, issue: '', detail: 'Terminal', customIssue: false, resuming: false, model: null, activeAgents: [] },
    ])
    onActiveTabChange(tabId)
    if (agent !== 'terminal') {
      setTimeout(() => {
        const cmd = agent === 'gemini' ? 'gemini\r' : agent === 'codex' ? 'codex\r' : model ? `claude --model ${model}\r` : 'claude\r'
        window.electronAPI.sendTerminalInput(tabId, cmd)
        if (initialPrompt) {
          // Wait for agent to initialize before sending the prompt
          setTimeout(() => {
            window.electronAPI.sendTerminalInput(tabId, initialPrompt + '\r')
          }, 4000)
        }
      }, 1000)
    }
  }, [onActiveTabChange, defaultAgent])

  useImperativeHandle(ref, () => ({
    sendToNewTab: (prompt: string, agent: 'claude' | 'gemini' | 'codex') => {
      createTab(agent, prompt)
    },
    resumeSession: async (sessionId: string) => {
      const tabId = await window.electronAPI.createTerminal(undefined, sessionId)
      setTabs((prev) => [
        ...prev,
        { id: tabId, issue: '', detail: 'Terminal', customIssue: false, resuming: true, model: null, activeAgents: [] },
      ])
      onActiveTabChange(tabId)
      setTimeout(() => {
        window.electronAPI.sendTerminalInput(tabId, `claude --resume ${sessionId}\r`)
      }, 1000)
    },
  }), [createTab, onActiveTabChange])

  // Actual close logic (no confirmation)
  const doCloseTab = useCallback(
    (tabId: string) => {
      setConfirmClose(null)
      setTabs((prev) => {
        if (prev.length <= 1) return prev
        const idx = prev.findIndex((t) => t.id === tabId)
        const updated = prev.filter((t) => t.id !== tabId)
        window.electronAPI.closeTerminal(tabId)
        // Let App repair pane assignments (handles active tab, split panes, etc.)
        const fallback = updated[Math.min(idx, updated.length - 1)].id
        onTabRemoved(tabId, fallback)
        return updated
      })
    },
    [onTabRemoved]
  )
  doCloseTabRef.current = doCloseTab

  // Close with confirmation always
  const closeTab = useCallback(
    (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId)
      setConfirmClose({ tabId, issue: tab?.issue || tab?.detail || 'このタブ' })
    },
    [tabs]
  )
  closeTabRef.current = closeTab

  // Restore a closed tab
  const restoreTab = useCallback(
    async (entry: ClosedEntry) => {
      setShowRestoreMenu(false)
      if (entry.claudeSessionId) {
        window.electronAPI.removeClosedHistory(entry.claudeSessionId)
      }
      const tabId = await window.electronAPI.createTerminal(
        entry.cwd,
        entry.claudeSessionId ?? undefined
      )
      if (entry.issue) {
        await window.electronAPI.setTerminalIssue(tabId, entry.issue)
      }
      setTabs((prev) => [
        ...prev,
        { id: tabId, issue: entry.issue, detail: '', customIssue: !!entry.issue, resuming: false, model: entry.agent === 'claude' ? entry.model : null, activeAgents: [] },
      ])
      onActiveTabChange(tabId)
      setTimeout(() => {
        const modelFlag = entry.model ? ` --model ${entry.model}` : ''
        const cmd = entry.agent === 'gemini'
          ? 'gemini --resume latest\r'
          : entry.agent === 'codex'
          ? 'codex\r'
          : entry.claudeSessionId ? `claude${modelFlag} --resume ${entry.claudeSessionId}\r` : `claude${modelFlag}\r`
        window.electronAPI.sendTerminalInput(tabId, cmd)
      }, 1000)
    },
    [onActiveTabChange]
  )

  const handleTabMouseDown = useCallback((e: React.MouseEvent, idx: number) => {
    if (editingTabId || e.button !== 0) return
    // Capsule tabs are not draggable (minimal Chrome-style integration:
    // the pair always stays adjacent, so reordering them is disabled)
    const tabId = tabsRef.current[idx]?.id
    if (splitPair && (tabId === splitPair[0] || tabId === splitPair[1])) return
    const startX = e.clientX
    let started = false

    const onMouseMove = (me: MouseEvent) => {
      if (!started) {
        if (Math.abs(me.clientX - startX) < 5) return
        started = true
        dragSrcIdx.current = idx
        setDragSrcIdxState(idx)
        document.body.style.cursor = 'grabbing'
      }
      const el = document.elementFromPoint(me.clientX, me.clientY)
      const tabEl = el?.closest('[data-tab-idx]')
      const overIdx = tabEl ? parseInt(tabEl.getAttribute('data-tab-idx') ?? '-1') : -1
      if (overIdx !== dragOverIdxRef.current) {
        dragOverIdxRef.current = overIdx
        setDragOverIdx(overIdx)
      }
    }

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      const from = dragSrcIdx.current
      const to = dragOverIdxRef.current
      dragSrcIdx.current = -1
      dragOverIdxRef.current = -1
      setDragSrcIdxState(-1)
      setDragOverIdx(-1)
      if (started && from !== -1 && to !== -1 && from !== to) {
        setTabs((prev) => {
          const next = [...prev]
          const [moved] = next.splice(from, 1)
          next.splice(to, 0, moved)
          window.electronAPI.reorderTerminals(next.map((t) => t.id))
          return next
        })
      }
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [editingTabId, splitPair])

  const startEditing = (tabId: string, currentIssue: string) => {
    setEditingTabId(tabId)
    setEditValue(currentIssue)
  }

  const commitRename = () => {
    if (!editingTabId) return
    const trimmed = editValue.trim()
    if (trimmed) {
      window.electronAPI.setTerminalIssue(editingTabId, trimmed)
      setTabs((prev) =>
        prev.map((t) =>
          t.id === editingTabId ? { ...t, issue: trimmed, customIssue: true } : t
        )
      )
    }
    setEditingTabId(null)
  }

  const cancelEditing = () => {
    setEditingTabId(null)
  }

  // Keyboard shortcuts: Cmd+1-9 switch tab, Cmd+Option+Left/Right navigate tabs, Ctrl+Tab cycle tabs
  useEffect(() => {
    const navigateTab = (direction: 'prev' | 'next') => {
      const currentIdx = tabsRef.current.findIndex((t) => t.id === activeTabId)
      if (currentIdx === -1) return
      const nextIdx = direction === 'prev'
        ? (currentIdx - 1 + tabsRef.current.length) % tabsRef.current.length
        : (currentIdx + 1) % tabsRef.current.length
      onActiveTabChange(tabsRef.current[nextIdx].id)
    }

    const handler = (e: KeyboardEvent) => {
      // Ctrl+Tab: next tab / Ctrl+Shift+Tab: previous tab
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        navigateTab(e.shiftKey ? 'prev' : 'next')
        return
      }

      if (!e.metaKey) return

      // Cmd+1~8: switch to tab by index
      if (e.key >= '1' && e.key <= '8') {
        const idx = parseInt(e.key) - 1
        const target = tabsRef.current[idx]
        if (target) {
          e.preventDefault()
          onActiveTabChange(target.id)
        }
        return
      }
      // Cmd+9: switch to last tab
      if (e.key === '9') {
        const last = tabsRef.current[tabsRef.current.length - 1]
        if (last) {
          e.preventDefault()
          onActiveTabChange(last.id)
        }
        return
      }
      // Cmd+Option+Left/Right: previous/next tab
      if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        navigateTab(e.key === 'ArrowLeft' ? 'prev' : 'next')
        return
      }
      // Cmd+T: new tab
      if (e.key === 't') {
        e.preventDefault()
        createTab()
        return
      }
      // Cmd+Shift+\: swap split panes (Chrome-style「分割ビューを並べ替える」).
      // Shift+\ emits '|' on US/JIS layouts; some layouts keep '\' (or '¥' on JIS)
      if (e.shiftKey && (e.key === '|' || e.key === '\\' || e.key === '¥')) {
        e.preventDefault()
        if (panes[1] !== null) onSwapSplit()
        return
      }
      // Cmd+\: toggle split view (JIS keyboards emit '¥' for the same physical key)
      if (e.key === '\\' || e.key === '¥') {
        e.preventDefault()
        if (panes[1] !== null) {
          onCloseRightPane()
        } else {
          // Pair the active tab with its neighbor (next, else previous) —
          // with 3+ tabs, "first tab in the list" was unpredictable
          const idx = tabsRef.current.findIndex((t) => t.id === activeTabId)
          const candidate = tabsRef.current[idx + 1] ?? tabsRef.current[idx - 1]
          if (candidate) onAddToSplit(candidate.id)
        }
        return
      }
      // Cmd+W: close active tab (with confirmation)
      if (e.key === 'w') {
        e.preventDefault()
        if (activeTabId) closeTabRef.current(activeTabId)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [activeTabId, onActiveTabChange, createTab, panes, onAddToSplit, onSwapSplit, onCloseRightPane])

  if (tabs.length === 0) {
    return null
  }

  const renderTab = (tab: Tab, idx: number) => (
    <div
      key={tab.id}
      data-tab-idx={idx}
      data-tab-id={tab.id}
      className={`tab ${tab.id === activeTabId ? 'tab-active' : ''} ${tab.id !== activeTabId && (tab.id === panes[0] || tab.id === panes[1]) ? 'tab-in-pane' : ''} ${tab.issue ? 'tab-two-line' : ''} ${dragOverIdx === idx && dragSrcIdxState !== idx ? 'tab-drag-over' : ''} ${dragSrcIdxState === idx ? 'tab-dragging' : ''}`}
      onMouseDown={(e) => handleTabMouseDown(e, idx)}
      onClick={() => onActiveTabChange(tab.id)}
      onDoubleClick={() => startEditing(tab.id, tab.issue)}
      onContextMenu={(e) => {
        e.preventDefault()
        setCtxMenu({ x: e.clientX, y: e.clientY, tabId: tab.id })
      }}
    >
      {editingTabId === tab.id ? (
        <input
          ref={editInputRef}
          className="tab-rename-input"
          value={editValue}
          placeholder="Issue name..."
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') cancelEditing()
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <div className="tab-labels">
          {tab.issue && <span className="tab-issue">{tab.issue}</span>}
          <span className={`tab-detail ${tab.resuming ? 'tab-detail-resuming' : ''}`}>{tab.detail}</span>
        </div>
      )}
      {editingTabId !== tab.id && (() => {
        const badge = getModelBadge(tab.model)
        const agents = tab.activeAgents
        if (!badge && agents.length === 0) return null
        const togglePopover = (e: React.MouseEvent) => {
          e.stopPropagation()
          // Anchor on the clicked tab element (not the tiny badge span): the
          // panel opens directly below the clicked tab, aligned to its left edge.
          const tabEl = (e.currentTarget as HTMLElement).closest('.tab')
          const rect = (tabEl ?? (e.currentTarget as HTMLElement)).getBoundingClientRect()
          const POPOVER_WIDTH = 280 // matches .tab-agent-popover max-width
          let x = rect.left
          if (x + POPOVER_WIDTH > window.innerWidth - 8) {
            // Near the right edge: clamp back inside the viewport
            x = Math.max(8, window.innerWidth - POPOVER_WIDTH - 8)
          }
          const y = rect.bottom + 6
          setAgentPopover((cur) => (cur?.tabId === tab.id ? null : { tabId: tab.id, x, y }))
        }
        return (
          <span className="tab-agent-badge-area" onClick={togglePopover}>
            {badge && (
              <span className="tab-model-badge" style={{ color: badge.color }} title={badge.full}>
                <span className="tab-model-dot" style={{ background: badge.color }} />
                {badge.letter}
              </span>
            )}
            {agents.length > 0 && (
              <span className="tab-agent-count" title={`並行稼働agent: ${agents.length}`}>
                +{agents.length}
              </span>
            )}
            {agentPopover?.tabId === tab.id && (
              <div
                className="tab-agent-popover"
                style={{ left: agentPopover.x, top: agentPopover.y }}
                onClick={(e) => e.stopPropagation()}
              >
                {agents.length === 0 ? (
                  <div className="tab-agent-popover-empty">稼働中のagentなし</div>
                ) : (
                  agents.map((a) => {
                    const ab = getModelBadge(a.model)
                    return (
                      <div key={a.label} className="tab-agent-popover-item">
                        <span className="tab-model-dot" style={{ background: ab?.color ?? 'var(--text-muted)' }} />
                        <span
                          className="tab-agent-popover-letter"
                          style={{ color: ab?.color ?? 'var(--text-muted)' }}
                          title={ab ? (a.model?.includes('継承') ? `${ab.full} (継承)` : ab.full) : (a.model ?? undefined)}
                        >
                          {ab?.letter ?? '?'}
                        </span>
                        <span className="tab-agent-popover-label">{a.label}</span>
                        <span className="tab-agent-popover-status">{a.status === 'started' ? '実行中' : '完了'}</span>
                      </div>
                    )
                  })
                )}
              </div>
            )}
          </span>
        )
      })()}
      {tabs.length > 1 && editingTabId !== tab.id && (
        <button
          className="tab-close"
          onClick={(e) => {
            e.stopPropagation()
            closeTab(tab.id)
          }}
        >
          ×
        </button>
      )}
    </div>
  )

  return (
    <div className="terminal-panel">
      <div className="tab-bar">
        <div className="tab-bar-tabs">
          {tabs.map((tab, idx) => {
            // Chrome-style capsule: when the split pair is adjacent in the tab
            // bar, wrap the two tabs in a single rounded frame. The capsule
            // persists while a non-pair tab is shown solo (pair remembered).
            if (splitPair) {
              if (tab.id === splitPair[1] && tabs[idx - 1]?.id === splitPair[0]) {
                return null // rendered inside the capsule below
              }
              if (tab.id === splitPair[0] && tabs[idx + 1]?.id === splitPair[1]) {
                return (
                  <div className="tab-capsule" key={`capsule-${splitPair[0]}`}>
                    {renderTab(tab, idx)}
                    {renderTab(tabs[idx + 1], idx + 1)}
                  </div>
                )
              }
            }
            return renderTab(tab, idx)
          })}
        </div>
        <div className="tab-bar-actions">
          <div className="tab-new-wrapper" ref={agentMenuRef}>
            <button className="tab-new" onClick={() => setShowAgentMenu((v) => !v)}>
              +
            </button>
            {showAgentMenu && (() => {
              const agentItems: Array<{ agent: 'claude' | 'gemini' | 'codex'; icon: string; label: string }> = [
                { agent: 'claude', icon: '◆', label: 'Claude' },
                { agent: 'gemini', icon: '◇', label: 'Gemini' },
                { agent: 'codex', icon: '⬡', label: 'Codex' },
              ]
              const sorted = [
                ...agentItems.filter((a) => a.agent === defaultAgent),
                ...agentItems.filter((a) => a.agent !== defaultAgent),
              ]
              return (
              <div className="tab-agent-menu">
                {sorted.map(({ agent, icon, label }) => (
                  agent === 'claude' ? (
                    // Claude row: label launches with the CLI default model (no badge);
                    // the model chips launch `claude --model <m>` (badge shown on the tab)
                    <div
                      key={agent}
                      className={`tab-agent-item${agent === defaultAgent ? ' tab-agent-default' : ''}`}
                      onClick={() => { createTab(agent); setShowAgentMenu(false) }}
                    >
                      <span className="agent-icon">{icon}</span>
                      {label}
                      <span className="tab-agent-models">
                        {MENU_MODELS.map((m) => (
                          <button
                            key={m}
                            className="tab-model-chip"
                            style={{ color: CLAUDE_MODELS[m].color }}
                            title={CLAUDE_MODELS[m].full}
                            onClick={(e) => { e.stopPropagation(); createTab('claude', undefined, m); setShowAgentMenu(false) }}
                          >
                            {CLAUDE_MODELS[m].letter}
                          </button>
                        ))}
                      </span>
                    </div>
                  ) : (
                  <button
                    key={agent}
                    className={`tab-agent-item${agent === defaultAgent ? ' tab-agent-default' : ''}`}
                    onClick={() => { createTab(agent); setShowAgentMenu(false) }}
                  >
                    <span className="agent-icon">{icon}</span>
                    {label}
                  </button>
                  )
                ))}
                <button
                  className="tab-agent-item"
                  onClick={() => { createTab('terminal'); setShowAgentMenu(false) }}
                >
                  <span className="agent-icon">$</span>
                  Terminal
                </button>
              </div>
              )
            })()}
          </div>
          <div className="tab-restore-wrapper" ref={restoreMenuRef}>
            <button
              className="tab-restore-btn"
              onClick={() => setShowRestoreMenu((v) => !v)}
              title={t.restoreTab}
              disabled={closedHistory.length === 0}
            >
              ↺
            </button>
            {showRestoreMenu && closedHistory.length > 0 && (
              <div className="tab-restore-menu">
                {closedHistory.map((entry, i) => (
                  <button
                    key={i}
                    className="tab-restore-item"
                    onClick={() => restoreTab(entry)}
                  >
                    <span className="restore-item-issue">{entry.issue || '(無題)'}</span>
                    <span className="restore-item-cwd">{entry.cwd.split('/').pop() || entry.cwd}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {confirmClose && (
        <div className="tab-confirm-bar">
          <span>「{confirmClose.issue}{t.closeConfirm}</span>
          <button
            className="tab-confirm-btn-close"
            onClick={() => {
              doCloseTab(confirmClose.tabId)
              setConfirmClose(null)
            }}
          >
            {t.close}
          </button>
          <button
            className="tab-confirm-btn-cancel"
            onClick={() => setConfirmClose(null)}
          >
            {t.cancel}
          </button>
        </div>
      )}
      <div className="terminal-tabs-content" ref={contentRef}>
        {tabs.map((tab) => {
          const splitActive = panes[1] !== null
          const pane: 0 | 1 | null =
            tab.id === panes[0] ? 0 : splitActive && tab.id === panes[1] ? 1 : null
          const paneStyle: CSSProperties | undefined =
            splitActive && pane !== null
              ? pane === 0
                ? { right: `${100 - splitRatio}%` }
                : { left: `${splitRatio}%` }
              : undefined
          return (
            <Terminal
              key={tab.id}
              tabId={tab.id}
              visible={pane !== null}
              focused={splitActive && pane === focusedPane}
              paneStyle={paneStyle}
              fontSize={fontSize}
              onFocusRequest={splitActive && pane !== focusedPane ? () => onActiveTabChange(tab.id) : undefined}
            />
          )
        })}
        {panes[1] !== null && (
          <>
            <div
              className="pane-divider"
              style={{ left: `calc(${splitRatio}% - 3px)` }}
              onMouseDown={handlePaneResize}
            />
            <button
              className="pane-close-btn"
              title="右ペインを閉じる (⌘\)"
              onClick={onCloseRightPane}
            >
              ×
            </button>
          </>
        )}
      </div>
      {ctxMenu && (() => {
        const splitActive = panes[1] !== null
        const inSplit = splitActive && (ctxMenu.tabId === panes[0] || ctxMenu.tabId === panes[1])
        // Chrome準拠:「新しい分割ビューにタブを追加」は右クリックしたタブを
        // 現在のアクティブタブと並べて表示する。アクティブタブ自身を右クリック
        // した場合は隣のタブ（次→前）をペアにする（単一表示時 panes[0] = アクティブタブ）。
        const splitTarget = (() => {
          if (inSplit) return null
          if (splitActive || ctxMenu.tabId !== panes[0]) return ctxMenu.tabId
          const idx = tabs.findIndex((t) => t.id === ctxMenu.tabId)
          const neighbor = tabs[idx + 1] ?? tabs[idx - 1]
          return neighbor ? neighbor.id : null
        })()
        return (
          <div
            className="tab-context-menu"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
          >
            {inSplit ? (
              <>
                <button
                  className="tab-agent-item"
                  onClick={() => {
                    onSwapSplit()
                    setCtxMenu(null)
                  }}
                >
                  分割ビューを並べ替える
                </button>
                <button
                  className="tab-agent-item"
                  onClick={() => {
                    onRemoveFromSplit(ctxMenu.tabId)
                    setCtxMenu(null)
                  }}
                >
                  分割ビューから削除
                </button>
              </>
            ) : (
              tabs.length > 1 && splitTarget !== null && (
                <button
                  className="tab-agent-item"
                  onClick={() => {
                    onAddToSplit(splitTarget)
                    setCtxMenu(null)
                  }}
                >
                  新しい分割ビューにタブを追加
                </button>
              )
            )}
            <button
              className="tab-agent-item"
              onClick={() => {
                startEditing(ctxMenu.tabId, tabsRef.current.find((t) => t.id === ctxMenu.tabId)?.issue || '')
                setCtxMenu(null)
              }}
            >
              名前を変更
            </button>
            {tabs.length > 1 && (
              <button
                className="tab-agent-item"
                onClick={() => {
                  closeTab(ctxMenu.tabId)
                  setCtxMenu(null)
                }}
              >
                タブを閉じる
              </button>
            )}
          </div>
        )
      })()}
    </div>
  )
})
