import { useState, useEffect, useCallback } from 'react'

interface ResumeSession {
  id: string
  title: string
  projectDir: string
  updatedAt: number
  sizeBytes: number
}

interface Props {
  projectDirs: string[]
  onResumeSession: (sessionId: string) => void
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export function ResumeWidget({ projectDirs, onResumeSession }: Props) {
  const [sessions, setSessions] = useState<ResumeSession[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.listResumeSessions(projectDirs.length > 0 ? projectDirs : null)
      setSessions(result)
    } catch {
      setSessions([])
    } finally {
      setLoading(false)
    }
  }, [projectDirs])

  useEffect(() => {
    load()
  }, [load])

  const filtered = query.trim()
    ? sessions.filter((s) => s.title.toLowerCase().includes(query.toLowerCase()))
    : sessions

  return (
    <div className="resume-widget">
      <div className="resume-search-wrap">
        <span className="resume-search-icon">⌕</span>
        <input
          className="resume-search"
          placeholder="Search..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="resume-list">
        {loading && <div className="resume-empty">Loading...</div>}
        {!loading && filtered.length === 0 && <div className="resume-empty">No sessions</div>}
        {!loading && filtered.map((s) => (
          <div
            key={s.id}
            className="resume-item"
            onClick={() => onResumeSession(s.id)}
            title={s.title}
          >
            <span className="resume-title">{s.title}</span>
            <span className="resume-meta">{timeAgo(s.updatedAt)} · {formatSize(s.sizeBytes)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
