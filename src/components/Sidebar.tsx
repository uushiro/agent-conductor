import { useState, useEffect, useRef, useCallback } from 'react'
import { useTasks } from '../hooks/useTasks'
import { TaskItem } from './TaskItem'
import { ResumeWidget } from './ResumeWidget'
import { useLang, strings } from '../contexts/LangContext'
import { useSettings } from '../contexts/SettingsContext'
import type { TabInfo } from '../global'

interface Props {
  onTabSelect: (tabId: string) => void
  activeTabId: string
  onSendToAgent: (prompt: string, agent: 'claude' | 'gemini') => void
  onResumeSession: (sessionId: string) => void
  fileTreeVisible: boolean
  onToggleFileTree: () => void
  width: number
}

const MIN_FLEX = 0.05
const STORAGE_KEY = 'sidebar-widget-flex'

function loadFlex(ids: string[]): number[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return ids.map(() => 1)
    const saved: Record<string, number> = JSON.parse(raw)
    return ids.map((id) => saved[id] ?? 1)
  } catch {
    return ids.map(() => 1)
  }
}

function saveFlex(ids: string[], values: number[]) {
  const obj: Record<string, number> = {}
  ids.forEach((id, i) => { obj[id] = values[i] })
  localStorage.setItem(STORAGE_KEY, JSON.stringify(obj))
}

export function Sidebar({ activeTabId, onTabSelect, onSendToAgent, onResumeSession, fileTreeVisible, onToggleFileTree, width }: Props) {
  const { lang } = useLang()
  const t = strings[lang]
  const { sidebarWidgets, resumeProjectDirs } = useSettings()
  const { tasks, addTask, toggleTask, deleteTask, editTask, setTasks } = useTasks()
  const [input, setInput] = useState('')
  const [tabInfos, setTabInfos] = useState<TabInfo[]>([])
  const [flashTaskId, setFlashTaskId] = useState<string | null>(null)
  const [tooltip, setTooltip] = useState<{ text: string; top: number } | null>(null)
  const tasksRef = useRef(tasks)
  const sidebarRef = useRef<HTMLElement>(null)

  const enabledWidgets = (sidebarWidgets ?? []).filter((w) => w.enabled)
  const enabledIds = enabledWidgets.map((w) => w.id)

  const [flexValues, setFlexValues] = useState<number[]>(() => loadFlex(enabledIds))

  // Re-sync flex array when widget list changes
  const prevIdsKey = enabledIds.join(',')
  const prevIdsRef = useRef(prevIdsKey)
  if (prevIdsKey !== prevIdsRef.current) {
    prevIdsRef.current = prevIdsKey
    // Reset to loaded values synchronously (no useEffect to avoid flicker)
  }
  useEffect(() => {
    setFlexValues(loadFlex(enabledIds))
  }, [prevIdsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const showTooltip = (e: React.MouseEvent<HTMLElement>, text: string) => {
    const el = e.currentTarget
    if (el.scrollWidth <= el.clientWidth && !text.includes('\n')) return
    const rect = el.getBoundingClientRect()
    setTooltip({ text, top: rect.top + rect.height / 2 })
  }
  const hideTooltip = () => setTooltip(null)

  tasksRef.current = tasks

  useEffect(() => {
    return window.electronAPI.onTaskSetAll((tasksJson) => {
      try { setTasks(JSON.parse(tasksJson)) } catch { /* ignore */ }
    })
  }, [setTasks])

  useEffect(() => {
    return window.electronAPI.onTaskAdd((title) => {
      const normalized = title.trim().toLowerCase()
      const exists = tasksRef.current.some(t => t.title.trim().toLowerCase() === normalized)
      if (exists) return
      const id = addTask(title)
      if (id) {
        setFlashTaskId(id)
        setTimeout(() => setFlashTaskId(null), 1500)
      }
    })
  }, [addTask])

  useEffect(() => {
    const poll = () => window.electronAPI.listTerminalInfo().then(setTabInfos)
    poll()
    const interval = setInterval(poll, 2000)
    return () => clearInterval(interval)
  }, [])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    addTask(input)
    setInput('')
  }

  const pending = tasks.filter((t) => !t.done)
  const completed = tasks.filter((t) => t.done)

  const handleResizeDrag = useCallback((e: React.MouseEvent, idx: number) => {
    e.preventDefault()
    const startY = e.clientY
    const sidebarH = sidebarRef.current?.clientHeight ?? 600
    const startFlex = [...flexValues]
    const totalFlex = startFlex.reduce((s, v) => s + v, 0)

    const onMove = (me: MouseEvent) => {
      const deltaFlex = ((me.clientY - startY) / sidebarH) * totalFlex
      const next = [...startFlex]
      next[idx] = Math.max(MIN_FLEX, startFlex[idx] + deltaFlex)
      next[idx + 1] = Math.max(MIN_FLEX, startFlex[idx + 1] - deltaFlex)
      setFlexValues(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      setFlexValues((prev) => { saveFlex(enabledIds, prev); return prev })
    }
    document.body.style.cursor = 'row-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [flexValues, enabledIds])

  const renderWidgetContent = (id: string) => {
    if (id === 'sessions') return (
      <>
        <div className="sidebar-header">
          <span className="task-count" style={{ marginRight: 'auto', fontSize: 13 }}>{tabInfos.length} {t.sessions}</span>
          <button
            className={`sidebar-filetree-toggle${fileTreeVisible ? ' active' : ''}`}
            onClick={onToggleFileTree}
            title={fileTreeVisible ? 'Hide file tree' : 'Show file tree'}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 3h4l2 2h6v8H2V3z" />
              <path d="M6 8h4M6 10.5h4" />
            </svg>
          </button>
        </div>
        <div className="tab-list-sidebar tab-list-sidebar-scroll">
          {tabInfos.map((tab, idx) => (
            <div
              key={tab.id}
              className={`tab-list-item ${tab.id === activeTabId ? 'tab-list-item-active' : ''}`}
              onClick={() => onTabSelect(tab.id)}
            >
              <span className={`tab-status-dot ${tab.active ? 'dot-active' : 'dot-idle'}`} />
              <div className="tab-list-labels">
                <span
                  className="tab-list-issue"
                  onMouseEnter={(e) => showTooltip(e, tab.issue || `Session ${idx + 1}`)}
                  onMouseLeave={hideTooltip}
                >
                  {tab.issue || `Session ${idx + 1}`}
                </span>
                {(tab.lastOutput || tab.isResuming) && (
                  <span
                    className={`tab-last-output ${tab.isThinking || tab.isResuming ? 'tab-last-output-thinking' : ''}`}
                    onMouseEnter={(e) => showTooltip(e, tab.isResuming ? 'Resuming...' : tab.lastOutput)}
                    onMouseLeave={hideTooltip}
                  >
                    {tab.isResuming ? 'Resuming...' : tab.lastOutput}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </>
    )

    if (id === 'tasks') return (
      <>
        <div className="sidebar-header">
          <h2>{t.tasks}</h2>
          <span className="task-count">{lang === 'ja' ? `${pending.length}${t.remaining}` : `${pending.length} ${t.remaining}`}</span>
        </div>
        <form className="task-form" onSubmit={handleSubmit}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t.addTask}
            className="task-input"
          />
        </form>
        <div className="task-list">
          {pending.map((task) => (
            <TaskItem key={task.id} task={task} onToggle={toggleTask} onDelete={deleteTask} onEdit={editTask} onSendToAgent={onSendToAgent} flash={flashTaskId === task.id} onShowTooltip={showTooltip} onHideTooltip={hideTooltip} />
          ))}
          {completed.length > 0 && (
            <>
              <div className="task-divider">Completed</div>
              {completed.map((task) => (
                <TaskItem key={task.id} task={task} onToggle={toggleTask} onDelete={deleteTask} onEdit={editTask} onSendToAgent={onSendToAgent} flash={false} onShowTooltip={showTooltip} onHideTooltip={hideTooltip} />
              ))}
            </>
          )}
        </div>
      </>
    )

    if (id === 'resume') return (
      <>
        <div className="sidebar-header">
          <h2>Resume</h2>
        </div>
        <ResumeWidget projectDirs={resumeProjectDirs} onResumeSession={onResumeSession} />
      </>
    )

    return null
  }

  const elements: React.ReactNode[] = []
  enabledWidgets.forEach((w, idx) => {
    const flex = flexValues[idx] ?? 1
    elements.push(
      <div
        key={w.id}
        className="sidebar-widget"
        style={{ flex, minHeight: 0 }}
      >
        {renderWidgetContent(w.id)}
      </div>
    )
    if (idx < enabledWidgets.length - 1) {
      elements.push(
        <div
          key={`handle-${idx}`}
          className="widget-resize-handle"
          onMouseDown={(e) => handleResizeDrag(e, idx)}
        />
      )
    }
  })

  return (
    <aside ref={sidebarRef} className="sidebar" style={{ width, minWidth: width }}>
      {elements}
      {tooltip && (
        <div className="sidebar-tooltip" style={{ top: tooltip.top }}>
          {tooltip.text}
        </div>
      )}
    </aside>
  )
}
