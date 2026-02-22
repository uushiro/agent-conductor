import type { Task } from '../hooks/useTasks'

interface Props {
  task: Task
  onToggle: (id: string) => void
  onDelete: (id: string) => void
  onSendToAgent?: (prompt: string, agent: 'claude' | 'gemini') => void
  flash?: boolean
  onShowTooltip?: (e: React.MouseEvent<HTMLElement>, text: string) => void
  onHideTooltip?: () => void
}

export function TaskItem({ task, onToggle, onDelete, onSendToAgent, flash, onShowTooltip, onHideTooltip }: Props) {
  return (
    <div className={`task-item ${task.done ? 'done' : ''} ${flash ? 'task-flash' : ''}`}>
      <span
        className="task-title"
        onMouseEnter={onShowTooltip ? (e) => onShowTooltip(e, task.title) : undefined}
        onMouseLeave={onHideTooltip}
      >{task.title}</span>
      <div className="task-actions">
        {onSendToAgent && !task.done && (
          <button
            className="task-send-btn"
            title="新しいタブでClaudeに送る"
            onClick={() => onSendToAgent(task.title, 'claude')}
          >
            ◆
          </button>
        )}
        <button
          className="task-toggle-btn"
          title={task.done ? '未完了に戻す' : '完了にする'}
          onClick={() => onToggle(task.id)}
        >
          {task.done ? '↩' : '✓'}
        </button>
        <button className="task-delete" onClick={() => onDelete(task.id)}>
          ×
        </button>
      </div>
    </div>
  )
}
