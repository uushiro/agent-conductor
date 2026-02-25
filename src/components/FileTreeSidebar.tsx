import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { FileEntry } from '../global'
import { FileTreeNode } from './FileTreeNode'

interface Props {
  activeTabId: string
  visible: boolean
}

interface ContextMenu {
  x: number
  y: number
  entry: FileEntry
}

export function FileTreeSidebar({ activeTabId, visible }: Props) {
  const [rootPath, setRootPath] = useState<string | null>(() =>
    localStorage.getItem('filetree-root') || null
  )
  const [pinned, setPinned] = useState<boolean>(() =>
    localStorage.getItem('filetree-pinned') === 'true'
  )
  const [inputValue, setInputValue] = useState('')
  const [editing, setEditing] = useState(false)
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([])
  const [expanded, setExpanded] = useState<Map<string, FileEntry[]>>(new Map())
  const [showHidden, setShowHidden] = useState(false)
  const [tooltip, setTooltip] = useState<{ text: string; top: number } | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)
  const [copyToast, setCopyToast] = useState(false)

  const rootPathRef = useRef<string | null>(localStorage.getItem('filetree-root') || null)
  const inputRef = useRef<HTMLInputElement>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)


  // cwd 自動追従（2000ms polling）
  useEffect(() => {
    if (pinned) return

    const poll = () => {
      window.electronAPI.listTerminalInfo().then((infos) => {
        const tab = infos.find((t) => t.id === activeTabId)
        if (tab?.cwd && tab.cwd !== rootPathRef.current) {
          rootPathRef.current = tab.cwd
          setRootPath(tab.cwd)
        }
      })
    }

    poll()
    const id = setInterval(poll, 2000)
    return () => clearInterval(id)
  }, [activeTabId, pinned])

  // rootPath / pinned を localStorage に永続化
  useEffect(() => {
    if (rootPath) localStorage.setItem('filetree-root', rootPath)
    else localStorage.removeItem('filetree-root')
  }, [rootPath])

  useEffect(() => {
    localStorage.setItem('filetree-pinned', String(pinned))
  }, [pinned])

  // rootPath 変更時にツリーリロード
  useEffect(() => {
    if (!rootPath) return
    setExpanded(new Map())
    window.electronAPI.listDir(rootPath).then(setRootEntries)
    setInputValue(rootPath)
  }, [rootPath])


  // 編集モード開始時にフォーカス
  useEffect(() => {
    if (editing) {
      inputRef.current?.select()
    }
  }, [editing])

  const handleExpand = useCallback((dirPath: string) => {
    if (expanded.has(dirPath)) return
    window.electronAPI.listDir(dirPath).then((children) => {
      setExpanded((prev) => new Map(prev).set(dirPath, children))
    })
  }, [expanded])

  const handleCollapse = useCallback((dirPath: string) => {
    setExpanded((prev) => {
      const next = new Map(prev)
      next.delete(dirPath)
      return next
    })
  }, [])

  const handleFileClick = useCallback((entry: FileEntry) => {
    if (!activeTabId) return
    window.electronAPI.sendTerminalInput(activeTabId, entry.path)
  }, [activeTabId])

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault()
    e.stopPropagation()
    const x = Math.min(e.clientX, window.innerWidth - 170)
    const y = Math.min(e.clientY, window.innerHeight - 80)
    setContextMenu({ x, y, entry })
  }, [])

  const handleOpenInEditor = useCallback((filePath: string) => {
    window.electronAPI.openInEditor(filePath)
    setContextMenu(null)
  }, [])

  const handleSetAsRoot = useCallback((entry: FileEntry) => {
    const dir = entry.isDir ? entry.path : entry.path.replace(/\/[^/]+$/, '')
    rootPathRef.current = dir
    setRootPath(dir)
    setPinned(true)
    setContextMenu(null)
  }, [])

  const handleCopyPath = useCallback((filePath: string) => {
    window.electronAPI.writeClipboard(filePath)
    setContextMenu(null)
    // トースト表示
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setCopyToast(true)
    toastTimerRef.current = setTimeout(() => setCopyToast(false), 2000)
  }, [])

  const handleShowTooltip = useCallback((e: React.MouseEvent<HTMLElement>, text: string) => {
    const rect = e.currentTarget.getBoundingClientRect()
    setTooltip({ text, top: rect.top + rect.height / 2 })
  }, [])

  const handleHideTooltip = useCallback(() => {
    setTooltip(null)
  }, [])

  const handlePathClick = () => {
    setEditing(true)
  }

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const val = inputValue.trim()
      if (val) {
        rootPathRef.current = val
        setRootPath(val)
        setPinned(true)
      }
      setEditing(false)
    } else if (e.key === 'Escape') {
      setInputValue(rootPath || '')
      setEditing(false)
    }
  }

  const handleUnpin = () => {
    setPinned(false)
  }

  const displayPath = rootPath
    ? rootPath.replace(/^\/Users\/[^/]+/, '~')
    : '...'

  if (!visible) return null

  return (
    <aside className="file-tree-sidebar">
      {/* ヘッダー */}
      <div className="file-tree-header">
        <h2>Files</h2>
        <div className="file-tree-header-actions">
          <button
            className={`file-tree-toggle-hidden${showHidden ? ' active' : ''}`}
            onClick={() => setShowHidden((v) => !v)}
            title={showHidden ? 'Hide dotfiles' : 'Show dotfiles'}
          >
            .*
          </button>
        </div>
      </div>

      {/* パス行 */}
      <div className="file-tree-path-row">
        {editing ? (
          <input
            ref={inputRef}
            className="file-tree-path-input"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleInputKeyDown}
            onBlur={() => {
              setInputValue(rootPath || '')
              setEditing(false)
            }}
            placeholder="/path/to/dir"
          />
        ) : (
          <span
            className="file-tree-path-display"
            onClick={handlePathClick}
            title={rootPath || ''}
          >
            {displayPath}
          </span>
        )}
        {pinned && !editing && (
          <button
            className="file-tree-pin-btn pinned"
            onClick={handleUnpin}
            title="Unpin (follow active tab)"
          >
            📌
          </button>
        )}
      </div>

      {/* ツリー本体 */}
      <div className="file-tree-body">
        {rootEntries
          .filter((e) => showHidden || !e.name.startsWith('.'))
          .map((entry) => (
            <FileTreeNode
              key={entry.path}
              entry={entry}
              depth={0}
              expanded={expanded}
              showHidden={showHidden}
              onExpand={handleExpand}
              onCollapse={handleCollapse}
              onFileClick={handleFileClick}
              onContextMenu={handleContextMenu}
              onShowTooltip={handleShowTooltip}
              onHideTooltip={handleHideTooltip}
            />
          ))}
        {rootEntries.length === 0 && rootPath && (
          <div style={{ padding: '8px 12px', color: 'var(--text-muted)', fontSize: 11 }}>
            (empty)
          </div>
        )}
      </div>

      {/* ツールチップ */}
      {tooltip && (
        <div className="file-tree-tooltip" style={{ top: tooltip.top }}>
          {tooltip.text}
        </div>
      )}

      {/* コピートースト */}
      {copyToast && (
        <div className="file-tree-copy-toast">
          ✓ パスをコピーしました
        </div>
      )}

      {/* 右クリックメニュー（Portal + 全画面オーバーレイ） */}
      {contextMenu && createPortal(
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 599 }}
            onClick={() => setContextMenu(null)}
          />
          <div
            className="file-tree-context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y, zIndex: 600 }}
          >
            <button
              className="file-tree-context-item"
              onClick={() => handleOpenInEditor(contextMenu.entry.path)}
            >
              エディタで開く
            </button>
            <button
              className="file-tree-context-item"
              onClick={() => handleCopyPath(contextMenu.entry.path)}
            >
              パスをコピー
            </button>
            <button
              className="file-tree-context-item"
              onClick={() => handleSetAsRoot(contextMenu.entry)}
            >
              ルートに設定
            </button>
          </div>
        </>,
        document.body
      )}
    </aside>
  )
}
