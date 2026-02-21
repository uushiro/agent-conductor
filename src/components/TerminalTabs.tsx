import { useState, useEffect, useCallback, useRef } from 'react'
import { Terminal } from './Terminal'

interface Tab {
  id: string
  issue: string
  detail: string
  customIssue: boolean
}

interface Props {
  activeTabId: string
  onActiveTabChange: (tabId: string) => void
}

export function TerminalTabs({ activeTabId, onActiveTabChange }: Props) {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [editingTabId, setEditingTabId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)
  const initialized = useRef(false)

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
      for (const saved of session.tabs) {
        const tabId = await window.electronAPI.createTerminal(saved.cwd)
        if (saved.issue) {
          await window.electronAPI.setTerminalIssue(tabId, saved.issue)
        }
        if (saved.hadClaude) {
          claudeResumes.push({ tabId, sessionId: saved.claudeSessionId })
        }
        restored.push({
          id: tabId,
          issue: saved.issue,
          detail: '',
          customIssue: !!saved.issue,
        })
      }
      setTabs(restored)
      const activeIdx = Math.min(session.activeIndex, restored.length - 1)
      onActiveTabChange(restored[activeIdx]?.id || restored[0]?.id || '')

      // Auto-resume claude in tabs that had it running, staggered to ensure unique session tracking
      claudeResumes.forEach(({ tabId, sessionId }, i) => {
        setTimeout(() => {
          const cmd = sessionId ? `claude --resume ${sessionId}\r` : 'claude\r'
          window.electronAPI.sendTerminalInput(tabId, cmd)
        }, 1000 + i * 1500)
      })
    } else {
      createTab()
    }
  }

  // Poll tab titles from main process
  useEffect(() => {
    const interval = setInterval(() => {
      setTabs((prev) => {
        for (const tab of prev) {
          window.electronAPI.getTerminalTitle(tab.id).then(({ issue, detail }) => {
            setTabs((current) =>
              current.map((t) => {
                if (t.id !== tab.id) return t
                const newIssue = t.customIssue ? t.issue : issue
                if (newIssue === t.issue && detail === t.detail) return t
                return { ...t, issue: newIssue, detail }
              })
            )
          })
        }
        return prev
      })
    }, 2000)
    return () => clearInterval(interval)
  }, [])

  // Focus input when editing starts
  useEffect(() => {
    if (editingTabId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingTabId])

  const createTab = useCallback(async () => {
    const tabId = await window.electronAPI.createTerminal()
    setTabs((prev) => [
      ...prev,
      { id: tabId, issue: '', detail: 'Terminal', customIssue: false },
    ])
    onActiveTabChange(tabId)
    // Auto-start Claude Code
    setTimeout(() => {
      window.electronAPI.sendTerminalInput(tabId, 'claude\r')
    }, 1000)
  }, [onActiveTabChange])

  const closeTab = useCallback(
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
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab ${tab.id === activeTabId ? 'tab-active' : ''} ${tab.issue ? 'tab-two-line' : ''}`}
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
                <span className="tab-detail">{tab.detail}</span>
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
        <button className="tab-new" onClick={createTab}>
          +
        </button>
      </div>
      <div className="terminal-tabs-content">
        {tabs.map((tab) => (
          <Terminal key={tab.id} tabId={tab.id} isActive={tab.id === activeTabId} />
        ))}
      </div>
    </div>
  )
}
