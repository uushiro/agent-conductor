import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { version } from '../../package.json'
import { SettingsModal } from './SettingsModal'
import { useLang, strings } from '../contexts/LangContext'

export function StatusBar() {
  const [branch, setBranch] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<{ version: string; url: string } | null>(null)
  const { lang } = useLang()
  const t = strings[lang]

  useEffect(() => {
    window.electronAPI.getGitBranch().then(setBranch)

    // Refresh git branch every 10s
    const interval = setInterval(() => {
      window.electronAPI.getGitBranch().then(setBranch)
    }, 10000)

    const unsubUpdate = window.electronAPI.onUpdateAvailable((version, url) => {
      setUpdateInfo({ version, url })
    })

    return () => {
      clearInterval(interval)
      unsubUpdate()
    }
  }, [])

  return (
    <footer className="status-bar">
      <div className="status-left">
        <button
          className="status-settings-btn"
          onClick={() => setShowSettings(true)}
          title={t.settings}
        >
          ⚙
        </button>
        <button
          className="status-help-btn"
          onClick={() => setShowHelp(v => !v)}
          title={t.help}
        >
          ?
        </button>
        {branch && (
          <span className="status-item">
            {branch}
          </span>
        )}
      </div>
      <div className="status-right">
        {updateInfo && (
          <button
            className="status-update-btn"
            onClick={() => window.electronAPI.openExternal(updateInfo.url)}
          >
            {lang === 'ja'
              ? `v${updateInfo.version} がリリースされました。アップデートしてください`
              : `v${updateInfo.version} is available. Please update`}
          </button>
        )}
        <span className="status-item">Agent Conductor v{version}</span>
      </div>
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showHelp && createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 899 }} onClick={() => setShowHelp(false)} />
          <div className="help-modal">
            <div className="settings-header">
              <span className="settings-title">{t.help}</span>
              <button className="settings-close" onClick={() => setShowHelp(false)}>×</button>
            </div>
            <div className="settings-help-body">
              <div className="settings-help-item">
                <span className="settings-help-label">{lang === 'ja' ? 'タブ' : 'Tabs'}</span>
                <p>{t.helpTabs}</p>
              </div>
              <div className="settings-help-item">
                <span className="settings-help-label">{lang === 'ja' ? 'セッション' : 'Sessions'}</span>
                <p>{t.helpSessions}</p>
              </div>
              <div className="settings-help-item">
                <span className="settings-help-label">{lang === 'ja' ? 'サイドバー' : 'Sidebar'}</span>
                <p>{t.helpSidebar}</p>
              </div>
              <div className="settings-help-item">
                <span className="settings-help-label">{lang === 'ja' ? 'タスク連携' : 'Task Integration'}</span>
                <p>{t.helpTasksFromClaude}</p>
              </div>
              <div className="settings-help-item">
                <span className="settings-help-label">{lang === 'ja' ? 'ファイルツリー' : 'File Tree'}</span>
                <p>{t.helpFileTree}</p>
              </div>
              <div className="settings-help-item">
                <span className="settings-help-label">{lang === 'ja' ? 'ターミナル' : 'Terminal'}</span>
                <p>{t.helpTerminal}</p>
              </div>
            </div>
          </div>
        </>,
        document.body
      )}
    </footer>
  )
}
