import { useState, useEffect, useCallback } from 'react'

export interface Task {
  id: string
  title: string
  done: boolean
  createdAt: number
}

const STORAGE_KEY = 'claude-cockpit-tasks'

function loadTasks(): Task[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveTasks(tasks: Task[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks))
}

export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>(loadTasks)

  useEffect(() => {
    saveTasks(tasks)
  }, [tasks])

  const addTask = useCallback((title: string) => {
    if (!title.trim()) return
    setTasks((prev) => [
      ...prev,
      { id: crypto.randomUUID(), title: title.trim(), done: false, createdAt: Date.now() },
    ])
  }, [])

  const toggleTask = useCallback((id: string) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t))
    )
  }, [])

  const deleteTask = useCallback((id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id))
  }, [])

  return { tasks, addTask, toggleTask, deleteTask }
}
