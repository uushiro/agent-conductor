import { useEffect, useState } from 'react'
import { version } from '../../package.json'
import { SettingsModal } from './SettingsModal'

export function StatusBar() {
  const [branch, setBranch] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    window.electronAPI.getGitBranch().then(setBranch)

    // Refresh git branch every 10s
    const interval = setInterval(() => {
      window.electronAPI.getGitBranch().then(setBranch)
    }, 10000)

    return () => clearInterval(interval)
  }, [])

  return (
    <footer className="status-bar">
      <div className="status-left">
        <button
          className="status-settings-btn"
          onClick={() => setShowSettings(true)}
          title="Settings"
        >
          ⚙
        </button>
        {branch && (
          <span className="status-item">
            {branch}
          </span>
        )}
      </div>
      <div className="status-right">
        <span className="status-item">Agent Conductor v{version}</span>
      </div>
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </footer>
  )
}
