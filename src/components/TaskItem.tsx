import { useState, useEffect, useRef } from 'react'
import type { Task } from '../hooks/useTasks'

interface Props {
  task: Task
  onToggle: (id: string) => void
  onDelete: (id: string) => void
  onEdit: (id: string, newTitle: string) => void
  onSendToAgent?: (prompt: string, agent: 'claude' | 'gemini') => void
  flash?: boolean
  onShowTooltip?: (e: React.MouseEvent<HTMLElement>, text: string) => void
  onHideTooltip?: () => void
}

export function TaskItem({ task, onToggle, onDelete, onEdit, onSendToAgent, flash, onShowTooltip, onHideTooltip }: Props) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const startEdit = () => {
    setEditValue(task.title)
    setEditing(true)
  }

  const commitEdit = () => {
    if (editValue.trim()) {
      onEdit(task.id, editValue)
    }
    setEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commitEdit()
    } else if (e.key === 'Escape') {
      setEditing(false)
    }
  }

  return (
    <div className={`task-item ${task.done ? 'done' : ''} ${flash ? 'task-flash' : ''}`}>
      {editing ? (
        <input
          ref={inputRef}
          className="task-edit-input"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={commitEdit}
        />
      ) : (
        <span
          className="task-title"
          onDoubleClick={startEdit}
          onMouseEnter={onShowTooltip ? (e) => onShowTooltip(e, task.title) : undefined}
          onMouseLeave={onHideTooltip}
        >{task.title}</span>
      )}
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
