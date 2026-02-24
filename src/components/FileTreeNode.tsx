import type { FileEntry } from '../global'

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

  const icon = entry.isDir ? (isExpanded ? '▼' : '▶') : ' '

  return (
    <>
      <div
        className="file-tree-node"
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={handleClick}
        onContextMenu={(e) => onContextMenu(e, entry)}
      >
        <span className="file-tree-node-icon">{icon}</span>
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
