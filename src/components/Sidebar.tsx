import { useState, useEffect } from 'react'
import { useTasks } from '../hooks/useTasks'
import { TaskItem } from './TaskItem'
import type { TabInfo } from '../global'


interface Props {
  onTabSelect: (tabId: string) => void
  activeTabId: string
}

const HOME_RE = /^\/Users\/[^/]+/

function shortPath(cwd: string): string {
  return cwd.replace(HOME_RE, '~')
}

export function Sidebar({ activeTabId, onTabSelect }: Props) {
  const { tasks, addTask, toggleTask, deleteTask } = useTasks()
  const [input, setInput] = useState('')
  const [tabInfos, setTabInfos] = useState<TabInfo[]>([])

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
          <h2>Sessions</h2>
          <span className="task-count">{tabInfos.length}</span>
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
                <span className="tab-list-issue">
                  {tab.issue || `Session ${idx + 1}`}
                </span>
                {tab.lastOutput && (
                  <span className={`tab-last-output ${tab.isThinking ? 'tab-last-output-thinking' : ''}`}>
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
          <button type="submit" className="task-add-btn">+</button>
        </form>

        <div className="task-list">
          {pending.map((task) => (
            <TaskItem key={task.id} task={task} onToggle={toggleTask} onDelete={deleteTask} />
          ))}
          {completed.length > 0 && (
            <>
              <div className="task-divider">Completed</div>
              {completed.map((task) => (
                <TaskItem key={task.id} task={task} onToggle={toggleTask} onDelete={deleteTask} />
              ))}
            </>
          )}
        </div>
      </div>
    </aside>
  )
}
