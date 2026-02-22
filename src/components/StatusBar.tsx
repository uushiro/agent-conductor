import { useEffect, useState } from 'react'

export function StatusBar() {
  const [cwd, setCwd] = useState('')
  const [branch, setBranch] = useState<string | null>(null)

  useEffect(() => {
    window.electronAPI.getCwd().then(setCwd)
    window.electronAPI.getGitBranch().then(setBranch)

    // Refresh git branch every 10s
    const interval = setInterval(() => {
      window.electronAPI.getGitBranch().then(setBranch)
    }, 10000)

    return () => clearInterval(interval)
  }, [])

  // Shorten home dir
  const displayCwd = cwd.replace(/^\/Users\/[^/]+/, '~')

  return (
    <footer className="status-bar">
      <div className="status-left">
        <span className="status-item">
          {displayCwd}
        </span>
        {branch && (
          <span className="status-item">
            {branch}
          </span>
        )}
      </div>
      <div className="status-right">
        <span className="status-item">Agent Conductor v0.1</span>
      </div>
    </footer>
  )
}
