import type { Task } from '../hooks/useTasks'

interface Props {
  task: Task
  onToggle: (id: string) => void
  onDelete: (id: string) => void
}

export function TaskItem({ task, onToggle, onDelete }: Props) {
  return (
    <div className={`task-item ${task.done ? 'done' : ''}`}>
      <button className="task-check" onClick={() => onToggle(task.id)}>
        {task.done ? '✓' : '○'}
      </button>
      <span className="task-title">{task.title}</span>
      <button className="task-delete" onClick={() => onDelete(task.id)}>
        ×
      </button>
    </div>
  )
}
