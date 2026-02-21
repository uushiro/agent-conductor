import { useState } from 'react'
import { useTasks } from '../hooks/useTasks'
import { TaskItem } from './TaskItem'

export function Sidebar() {
  const { tasks, addTask, toggleTask, deleteTask } = useTasks()
  const [input, setInput] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    addTask(input)
    setInput('')
  }

  const pending = tasks.filter((t) => !t.done)
  const completed = tasks.filter((t) => t.done)

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h2>Tasks</h2>
        <span className="task-count">
          {pending.length} remaining
        </span>
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
    </aside>
  )
}
