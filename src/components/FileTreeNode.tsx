import type { FileEntry } from '../global'

const FILE_ICONS: Record<string, { icon: string; color: string }> = {
  '.ts': { icon: 'TS', color: '#3178c6' },
  '.tsx': { icon: 'TX', color: '#3178c6' },
  '.js': { icon: 'JS', color: '#f1e05a' },
  '.jsx': { icon: 'JX', color: '#f1e05a' },
  '.json': { icon: '{}', color: '#6e7681' },
  '.md': { icon: 'M↓', color: '#519aba' },
  '.css': { icon: '#', color: '#a855f7' },
  '.html': { icon: '<>', color: '#e34c26' },
  '.py': { icon: 'PY', color: '#3572a5' },
  '.sh': { icon: '$', color: '#3fb950' },
  '.yml': { icon: 'Y', color: '#cb171e' },
  '.yaml': { icon: 'Y', color: '#cb171e' },
  '.toml': { icon: 'T', color: '#9c4121' },
  '.env': { icon: '⚙', color: '#d29922' },
  '.gitignore': { icon: 'G', color: '#f05032' },
  '.svg': { icon: '◇', color: '#ffb13b' },
  '.png': { icon: '◻', color: '#a855f7' },
  '.jpg': { icon: '◻', color: '#a855f7' },
  '.ico': { icon: '◻', color: '#a855f7' },
}

function getFileIcon(name: string): { icon: string; color: string } {
  // Check full filename first (e.g. .gitignore, .env)
  if (FILE_ICONS[name]) return FILE_ICONS[name]
  // Check extension
  const dotIdx = name.lastIndexOf('.')
  if (dotIdx > 0) {
    const ext = name.slice(dotIdx)
    if (FILE_ICONS[ext]) return FILE_ICONS[ext]
  }
  return { icon: '·', color: '#6e7681' }
}

interface Props {
  entry: FileEntry
  depth: number
  expanded: Map<string, FileEntry[]>
  showHidden: boolean
  onExpand: (path: string) => void
  onCollapse: (path: string) => void
  onFileClick: (entry: FileEntry) => void
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void
  onShowTooltip: (e: React.MouseEvent<HTMLElement>, text: string) => void
  onHideTooltip: () => void
}

export function FileTreeNode({
  entry,
  depth,
  expanded,
  showHidden,
  onExpand,
  onCollapse,
  onFileClick,
  onContextMenu,
  onShowTooltip,
  onHideTooltip,
}: Props) {
  if (!showHidden && entry.name.startsWith('.')) return null

  const isExpanded = expanded.has(entry.path)
  const children = expanded.get(entry.path)

  const handleClick = () => {
    if (entry.isDir) {
      if (isExpanded) {
        onCollapse(entry.path)
      } else {
        onExpand(entry.path)
      }
    } else {
      onFileClick(entry)
    }
  }

  const chevron = entry.isDir ? (isExpanded ? '▾' : '›') : ''
  const fileIcon = entry.isDir ? null : getFileIcon(entry.name)

  return (
    <>
      <div
        className="file-tree-node"
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={handleClick}
        onContextMenu={(e) => onContextMenu(e, entry)}
      >
        {entry.isDir ? (
          <span className="file-tree-node-chevron">{chevron}</span>
        ) : (
          <span className="file-tree-node-file-icon" style={{ color: fileIcon!.color }}>{fileIcon!.icon}</span>
        )}
        <span
          className={[
            'file-tree-node-name',
            entry.isDir ? 'is-dir' : '',
            entry.name.startsWith('.') ? 'is-hidden' : '',
          ].filter(Boolean).join(' ')}
          onMouseEnter={(e) => {
            const el = e.currentTarget
            if (el.scrollWidth > el.clientWidth) {
              onShowTooltip(e, entry.path)
            }
          }}
          onMouseLeave={onHideTooltip}
        >
          {entry.name}
        </span>
      </div>
      {entry.isDir && isExpanded && children && children.length > 0 && (
        <>
          {children
            .filter((c) => showHidden || !c.name.startsWith('.'))
            .map((child) => (
              <FileTreeNode
                key={child.path}
                entry={child}
                depth={depth + 1}
                expanded={expanded}
                showHidden={showHidden}
                onExpand={onExpand}
                onCollapse={onCollapse}
                onFileClick={onFileClick}
                onContextMenu={onContextMenu}
                onShowTooltip={onShowTooltip}
                onHideTooltip={onHideTooltip}
              />
            ))}
        </>
      )}
      {entry.isDir && isExpanded && children && children.length === 0 && (
        <div
          className="file-tree-node"
          style={{ paddingLeft: 8 + (depth + 1) * 12 }}
        >
          <span className="file-tree-node-name" style={{ color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 11 }}>
            (empty)
          </span>
        </div>
      )}
    </>
  )
}
