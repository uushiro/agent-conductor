import { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle } from 'react'
import { Terminal } from './Terminal'
import { useSettings } from '../contexts/SettingsContext'

export interface TerminalTabsHandle {
  sendToNewTab: (prompt: string, agent: 'claude' | 'gemini') => void
}

interface Tab {
  id: string
  issue: string
  detail: string
  customIssue: boolean
  resuming: boolean
}

interface ClosedEntry {
  issue: string
  cwd: string
  claudeSessionId: string | null
  agent: 'claude' | 'gemini'
  closedAt: number
}

interface Props {
  activeTabId: string
  onActiveTabChange: (tabId: string) => void
}

export const TerminalTabs = forwardRef<TerminalTabsHandle, Props>(function TerminalTabs({ activeTabId, onActiveTabChange }, ref) {
  const { fontSize } = useSettings()
  const [tabs, setTabs] = useState<Tab[]>([])
  const [editingTabId, setEditingTabId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [confirmClose, setConfirmClose] = useState<{ tabId: string; issue: string } | null>(null)
  const [closedHistory, setClosedHistory] = useState<ClosedEntry[]>([])
  const [showRestoreMenu, setShowRestoreMenu] = useState(false)
  const [showAgentMenu, setShowAgentMenu] = useState(false)
  const [dragOverIdx, setDragOverIdx] = useState<number>(-1)
  const [dragSrcIdxState, setDragSrcIdxState] = useState<number>(-1)
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
    const session = await window.electronAPI.loadSession()
    if (session && session.tabs.length > 0) {
      const restored: Tab[] = []
      const claudeResumes: Array<{ tabId: string; sessionId: string | null }> = []
      const geminiResumes: Array<{ tabId: string }> = []
      for (const saved of session.tabs) {
        const tabId = await window.electronAPI.createTerminal(
          saved.cwd,
          saved.hadClaude ? saved.claudeSessionId ?? undefined : undefined
        )
        if (saved.issue) {
          await window.electronAPI.setTerminalIssue(tabId, saved.issue)
        }
        if (saved.hadClaude) {
          claudeResumes.push({ tabId, sessionId: saved.claudeSessionId })
        } else if (saved.hadGemini) {
          geminiResumes.push({ tabId })
        }
        const willResume = saved.hadClaude || saved.hadGemini
        restored.push({
          id: tabId,
          issue: saved.issue,
          detail: willResume ? 'Resuming...' : '',
          customIssue: !!saved.issue,
          resuming: willResume,
        })
      }
      setTabs(restored)
      const activeIdx = Math.min(session.activeIndex, restored.length - 1)
      onActiveTabChange(restored[activeIdx]?.id || restored[0]?.id || '')

      // Auto-resume Claude tabs (3000ms stagger to prevent cross-tab session mixing)
      claudeResumes.forEach(({ tabId, sessionId }, i) => {
        setTimeout(() => {
          const cmd = sessionId ? `claude --resume ${sessionId}\r` : 'claude\r'
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
    } else {
      createTab()
    }
  }

  // Keep tabsRef in sync so polling can read current tabs without setTabs-for-reading
  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])

  // Poll tab titles from main process + clear resuming state when agent starts
  useEffect(() => {
    const interval = setInterval(() => {
      for (const tab of tabsRef.current) {
        window.electronAPI.getTerminalTitle(tab.id).then(({ issue, detail }) => {
          setTabs((current) =>
            current.map((t) => {
              if (t.id !== tab.id) return t
              // Clear resuming state once agent has produced real output
              const stillResuming = t.resuming && (!detail || detail === 'Resuming...')
              const newIssue = t.customIssue ? t.issue : issue
              const newDetail = stillResuming ? 'Resuming...' : detail
              if (newIssue === t.issue && newDetail === t.detail && stillResuming === t.resuming) return t
              return { ...t, issue: newIssue, detail: newDetail, resuming: stillResuming }
            })
          )
        })
      }
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

  // ref to always-current doCloseTab (used in keydown handler below)
  const doCloseTabRef = useRef<(tabId: string) => void>(() => {})

  // Escape cancels / Enter confirms the close dialog
  useEffect(() => {
    if (!confirmClose) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConfirmClose(null)
      if (e.key === 'Enter') {
        doCloseTabRef.current(confirmClose.tabId)
        setConfirmClose(null)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [confirmClose])

  const createTab = useCallback(async (agent: 'claude' | 'gemini' | 'terminal' = 'claude', initialPrompt?: string) => {
    const tabId = await window.electronAPI.createTerminal()
    setTabs((prev) => [
      ...prev,
      { id: tabId, issue: '', detail: 'Terminal', customIssue: false, resuming: false },
    ])
    onActiveTabChange(tabId)
    if (agent !== 'terminal') {
      setTimeout(() => {
        const cmd = agent === 'gemini' ? 'gemini\r' : 'claude\r'
        window.electronAPI.sendTerminalInput(tabId, cmd)
        if (initialPrompt) {
          // Wait for agent to initialize before sending the prompt
          setTimeout(() => {
            window.electronAPI.sendTerminalInput(tabId, initialPrompt + '\r')
          }, 4000)
        }
      }, 1000)
    }
  }, [onActiveTabChange])

  useImperativeHandle(ref, () => ({
    sendToNewTab: (prompt: string, agent: 'claude' | 'gemini') => {
      createTab(agent, prompt)
    },
  }), [createTab])

  // Actual close logic (no confirmation)
  const doCloseTab = useCallback(
    (tabId: string) => {
      setTabs((prev) => {
        if (prev.length <= 1) return prev
        const idx = prev.findIndex((t) => t.id === tabId)
        const updated = prev.filter((t) => t.id !== tabId)
        window.electronAPI.closeTerminal(tabId)
        if (tabId === activeTabId) {
          const newIdx = Math.min(idx, updated.length - 1)
          onActiveTabChange(updated[newIdx].id)
        }
        return updated
      })
    },
    [activeTabId, onActiveTabChange]
  )
  doCloseTabRef.current = doCloseTab

  // Close with confirmation if Claude session exists
  const closeTab = useCallback(
    async (tabId: string) => {
      const hasClaude = await window.electronAPI.getTabHasClaude(tabId)
      if (hasClaude) {
        const tab = tabs.find((t) => t.id === tabId)
        setConfirmClose({ tabId, issue: tab?.issue || tab?.detail || 'このタブ' })
        return
      }
      doCloseTab(tabId)
    },
    [tabs, doCloseTab]
  )

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
        { id: tabId, issue: entry.issue, detail: '', customIssue: !!entry.issue, resuming: false },
      ])
      onActiveTabChange(tabId)
      setTimeout(() => {
        const cmd = entry.agent === 'gemini'
          ? 'gemini --resume latest\r'
          : entry.claudeSessionId ? `claude --resume ${entry.claudeSessionId}\r` : 'claude\r'
        window.electronAPI.sendTerminalInput(tabId, cmd)
      }, 1000)
    },
    [onActiveTabChange]
  )

  const handleTabMouseDown = useCallback((e: React.MouseEvent, idx: number) => {
    if (editingTabId || e.button !== 0) return
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
  }, [editingTabId])

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

  if (tabs.length === 0) {
    return null
  }

  return (
    <div className="terminal-panel">
      <div className="tab-bar">
        <div className="tab-bar-tabs">
          {tabs.map((tab, idx) => (
            <div
              key={tab.id}
              data-tab-idx={idx}
              className={`tab ${tab.id === activeTabId ? 'tab-active' : ''} ${tab.issue ? 'tab-two-line' : ''} ${dragOverIdx === idx && dragSrcIdxState !== idx ? 'tab-drag-over' : ''} ${dragSrcIdxState === idx ? 'tab-dragging' : ''}`}
              onMouseDown={(e) => handleTabMouseDown(e, idx)}
              onClick={() => onActiveTabChange(tab.id)}
              onDoubleClick={() => startEditing(tab.id, tab.issue)}
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
          ))}
        </div>
        <div className="tab-bar-actions">
          <div className="tab-new-wrapper" ref={agentMenuRef}>
            <button className="tab-new" onClick={() => setShowAgentMenu((v) => !v)}>
              +
            </button>
            {showAgentMenu && (
              <div className="tab-agent-menu">
                <button
                  className="tab-agent-item tab-agent-default"
                  onClick={() => { createTab('claude'); setShowAgentMenu(false) }}
                >
                  <span className="agent-icon">◆</span>
                  Claude
                </button>
                <button
                  className="tab-agent-item"
                  onClick={() => { createTab('gemini'); setShowAgentMenu(false) }}
                >
                  <span className="agent-icon">◇</span>
                  Gemini
                </button>
                <button
                  className="tab-agent-item"
                  onClick={() => { createTab('terminal'); setShowAgentMenu(false) }}
                >
                  <span className="agent-icon">$</span>
                  Terminal
                </button>
              </div>
            )}
          </div>
          <div className="tab-restore-wrapper" ref={restoreMenuRef}>
            <button
              className="tab-restore-btn"
              onClick={() => setShowRestoreMenu((v) => !v)}
              title="最近閉じたタブを復元"
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
          <span>「{confirmClose.issue}」を閉じますか？後で復元できます。</span>
          <button
            className="tab-confirm-btn-close"
            onClick={() => {
              doCloseTab(confirmClose.tabId)
              setConfirmClose(null)
            }}
          >
            閉じる
          </button>
          <button
            className="tab-confirm-btn-cancel"
            onClick={() => setConfirmClose(null)}
          >
            キャンセル
          </button>
        </div>
      )}
      <div className="terminal-tabs-content">
        {tabs.map((tab) => (
          <Terminal
            key={tab.id}
            tabId={tab.id}
            isActive={tab.id === activeTabId}
            fontSize={fontSize}
          />
        ))}
      </div>
    </div>
  )
})
