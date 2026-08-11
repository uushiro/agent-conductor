import { useState, useEffect, useCallback, useRef } from 'react'

const POLL_INTERVAL_MS = 10000

interface ResumeSession {
  id: string
  title: string
  automaticTitle: string
  hasCustomTitle: boolean
  projectDir: string
  updatedAt: number
  sizeBytes: number
  agent: 'claude' | 'codex'
  cwd?: string
}

// Agent glyphs shared with the "+" agent menu in TerminalTabs (agent-icon class)
const AGENT_ICONS: Record<ResumeSession['agent'], string> = {
  claude: '◆',
  codex: '⬡',
}

interface Props {
  projectDirs: string[]
  onResumeSession: (sessionId: string, agent: 'claude' | 'codex', cwd?: string, title?: string) => void
}

function sessionKey(session: Pick<ResumeSession, 'agent' | 'id'>): string {
  return `${session.agent}:${session.id}`
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
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const loadedOnceRef = useRef(false)
  const cancelEditRef = useRef(false)
  const mutationGenerationRef = useRef(0)
  const loadGenerationRef = useRef(0)

  const load = useCallback(async (force = false) => {
    const loadGeneration = ++loadGenerationRef.current
    if (!loadedOnceRef.current || force) setLoading(true)
    const mutationGeneration = mutationGenerationRef.current
    try {
      const result = await window.electronAPI.listResumeSessions(projectDirs.length > 0 ? projectDirs : null)
      // A rename/reset may finish while this disk scan is in flight. Never let
      // that older result overwrite the optimistic local mutation.
      if (loadGeneration === loadGenerationRef.current && mutationGeneration === mutationGenerationRef.current) {
        setSessions(result)
      }
    } catch {
      if (loadGeneration === loadGenerationRef.current && mutationGeneration === mutationGenerationRef.current) {
        setSessions([])
      }
    } finally {
      if (loadGeneration === loadGenerationRef.current) {
        setLoading(false)
        loadedOnceRef.current = true
      }
    }
  }, [projectDirs])

  useEffect(() => {
    load()

    const interval = setInterval(() => {
      if (document.hidden) return
      load()
    }, POLL_INTERVAL_MS)

    const onFocus = () => load()
    window.addEventListener('focus', onFocus)

    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [load])

  const filtered = query.trim()
    ? sessions.filter((s) => {
        const q = query.toLowerCase()
        return s.title.toLowerCase().includes(q) || s.automaticTitle.toLowerCase().includes(q)
      })
    : sessions

  const beginRename = (event: React.MouseEvent, session: ResumeSession) => {
    event.stopPropagation()
    cancelEditRef.current = false
    setEditingKey(sessionKey(session))
    setEditValue(session.title)
  }

  const commitRename = async (session: ResumeSession) => {
    if (cancelEditRef.current) {
      cancelEditRef.current = false
      return
    }
    const title = editValue.trim().slice(0, 120)
    setEditingKey(null)
    const mutationGeneration = ++mutationGenerationRef.current
    const saved = await window.electronAPI.setResumeSessionTitle(session.agent, session.id, title || null)
    if (!saved || mutationGeneration !== mutationGenerationRef.current) return
    mutationGenerationRef.current += 1
    setSessions((current) => current.map((item) =>
      sessionKey(item) === sessionKey(session)
        ? { ...item, title: title || item.automaticTitle, hasCustomTitle: !!title }
        : item
    ))
  }

  const resetTitle = async (event: React.MouseEvent, session: ResumeSession) => {
    event.stopPropagation()
    const mutationGeneration = ++mutationGenerationRef.current
    const saved = await window.electronAPI.setResumeSessionTitle(session.agent, session.id, null)
    if (!saved || mutationGeneration !== mutationGenerationRef.current) return
    mutationGenerationRef.current += 1
    setSessions((current) => current.map((item) =>
      sessionKey(item) === sessionKey(session)
        ? { ...item, title: item.automaticTitle, hasCustomTitle: false }
        : item
    ))
  }

  const handleSessionClick = (session: ResumeSession) => {
    if (editingKey) return
    onResumeSession(session.id, session.agent, session.cwd, session.hasCustomTitle ? session.title : undefined)
  }

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
        <button
          className="resume-refresh-btn"
          onClick={() => load(true)}
          title="Refresh"
          aria-label="Refresh"
        >
          ⟳
        </button>
      </div>
      <div className="resume-list">
        {loading && <div className="resume-empty">Loading...</div>}
        {!loading && filtered.length === 0 && <div className="resume-empty">No sessions</div>}
        {!loading && filtered.map((s) => (
          <div
            key={`${s.agent}:${s.id}`}
            className="resume-item"
            onClick={() => handleSessionClick(s)}
            title={s.title}
          >
            <span className="resume-item-head">
              <span className="agent-icon">{AGENT_ICONS[s.agent]}</span>
              {editingKey === sessionKey(s) ? (
                <input
                  className="resume-title-input"
                  value={editValue}
                  maxLength={120}
                  autoFocus
                  onChange={(event) => setEditValue(event.target.value)}
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onBlur={() => commitRename(s)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                    if (event.key === 'Escape') {
                      cancelEditRef.current = true
                      setEditingKey(null)
                    }
                  }}
                />
              ) : (
                <span
                  className={`resume-title${s.hasCustomTitle ? ' resume-title-custom' : ''}`}
                  title={`${s.title}\nClick to resume`}
                >
                  {s.title}
                </span>
              )}
              {editingKey !== sessionKey(s) && (
                <button
                  className="resume-title-edit"
                  title="Rename session"
                  aria-label="Rename session"
                  onClick={(event) => beginRename(event, s)}
                  onDoubleClick={(event) => event.stopPropagation()}
                >
                  ✎
                </button>
              )}
              {s.hasCustomTitle && editingKey !== sessionKey(s) && (
                <button
                  className="resume-title-reset"
                  title={`Reset to automatic title: ${s.automaticTitle}`}
                  aria-label="Reset to automatic title"
                  onClick={(event) => resetTitle(event, s)}
                  onDoubleClick={(event) => event.stopPropagation()}
                >
                  ↶
                </button>
              )}
            </span>
            <span className="resume-meta">{timeAgo(s.updatedAt)} · {formatSize(s.sizeBytes)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
