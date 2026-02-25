import { useState, useEffect, useRef } from 'react'
import { useTasks } from '../hooks/useTasks'
import { TaskItem } from './TaskItem'
import type { TabInfo } from '../global'


interface Props {
  onTabSelect: (tabId: string) => void
  activeTabId: string
  onSendToAgent: (prompt: string, agent: 'claude' | 'gemini') => void
  fileTreeVisible: boolean
  onToggleFileTree: () => void
}

const HOME_RE = /^\/Users\/[^/]+/

function shortPath(cwd: string): string {
  return cwd.replace(HOME_RE, '~')
}

export function Sidebar({ activeTabId, onTabSelect, onSendToAgent, fileTreeVisible, onToggleFileTree }: Props) {
  const { tasks, addTask, toggleTask, deleteTask, editTask, setTasks } = useTasks()
  const [input, setInput] = useState('')
  const [tabInfos, setTabInfos] = useState<TabInfo[]>([])
  const [flashTaskId, setFlashTaskId] = useState<string | null>(null)
  const [tooltip, setTooltip] = useState<{ text: string; top: number } | null>(null)
  const tasksRef = useRef(tasks)

  const showTooltip = (e: React.MouseEvent<HTMLElement>, text: string) => {
    const el = e.currentTarget
    if (el.scrollWidth <= el.clientWidth && !text.includes('\n')) return
    const rect = el.getBoundingClientRect()
    setTooltip({ text, top: rect.top + rect.height / 2 })
  }
  const hideTooltip = () => setTooltip(null)

  // Keep ref in sync for stable closure in onTaskAdd listener
  tasksRef.current = tasks

  // Listen for task list replacement (external task management)
  useEffect(() => {
    return window.electronAPI.onTaskSetAll((tasksJson) => {
      try {
        const newTasks = JSON.parse(tasksJson)
        setTasks(newTasks)
      } catch { /* ignore parse errors */ }
    })
  }, [setTasks])

  // Listen for tasks added from sessions
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

  // Poll tab info from main process
  useEffect(() => {
    const poll = () => {
      window.electronAPI.listTerminalInfo().then(setTabInfos)
    }
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

  return (
    <aside className="sidebar">
      {/* Tab list */}
      <div className="sidebar-section">
        <div className="sidebar-header">
          <span className="task-count" style={{ marginRight: 'auto', fontSize: 13 }}>{tabInfos.length} sessions</span>
          <button
            className={`sidebar-filetree-toggle${fileTreeVisible ? ' active' : ''}`}
            onClick={onToggleFileTree}
            title={fileTreeVisible ? 'Hide file tree' : 'Show file tree'}
          >
            ▤
          </button>
        </div>
        <div className="tab-list-sidebar">
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
                {tab.lastOutput && (
                  <span
                    className={`tab-last-output ${tab.isThinking ? 'tab-last-output-thinking' : ''}`}
                    onMouseEnter={(e) => showTooltip(e, tab.lastOutput)}
                    onMouseLeave={hideTooltip}
                  >
                    {tab.lastOutput}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

{/* Task list */}
      <div className="sidebar-section sidebar-section-grow">
        <div className="sidebar-header">
          <h2>Tasks</h2>
          <span className="task-count">{pending.length} remaining</span>
        </div>

        <form className="task-form" onSubmit={handleSubmit}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Add a task..."
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
      </div>
      {tooltip && (
        <div className="sidebar-tooltip" style={{ top: tooltip.top }}>
          {tooltip.text}
        </div>
      )}
    </aside>
  )
}
