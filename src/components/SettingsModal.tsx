import { createPortal } from 'react-dom'
import { useSettings } from '../contexts/SettingsContext'
import { useLang } from '../contexts/LangContext'

interface Props {
  onClose: () => void
}

export function SettingsModal({ onClose }: Props) {
  const { theme, fontSize, editorCommand, updateSettings } = useSettings()
  const { lang, toggleLang } = useLang()

  return createPortal(
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 899 }}
        onClick={onClose}
      />
      <div className="settings-modal">
        <div className="settings-header">
          <span className="settings-title">Settings</span>
          <button className="settings-close" onClick={onClose}>×</button>
        </div>
        <div className="settings-body">
          <div className="settings-row">
            <label className="settings-label">Theme</label>
            <div className="settings-toggle-group">
              <button
                className={`settings-toggle-btn${theme === 'dark' ? ' active' : ''}`}
                onClick={() => updateSettings({ theme: 'dark' })}
              >
                Dark
              </button>
              <button
                className={`settings-toggle-btn${theme === 'light' ? ' active' : ''}`}
                onClick={() => updateSettings({ theme: 'light' })}
              >
                Light
              </button>
            </div>
          </div>

          <div className="settings-row">
            <label className="settings-label">Font Size</label>
            <div className="settings-font-row">
              <input
                type="range"
                min={11}
                max={20}
                value={fontSize}
                onChange={(e) => updateSettings({ fontSize: Number(e.target.value) })}
                className="settings-range"
              />
              <span className="settings-font-value">{fontSize}</span>
            </div>
          </div>

          <div className="settings-row">
            <label className="settings-label">Language</label>
            <div className="settings-toggle-group">
              <button
                className={`settings-toggle-btn${lang === 'en' ? ' active' : ''}`}
                onClick={() => lang !== 'en' && toggleLang()}
              >
                EN
              </button>
              <button
                className={`settings-toggle-btn${lang === 'ja' ? ' active' : ''}`}
                onClick={() => lang !== 'ja' && toggleLang()}
              >
                JA
              </button>
            </div>
          </div>

          <div className="settings-row">
            <label className="settings-label">Editor</label>
            <input
              type="text"
              className="settings-editor-input"
              value={editorCommand}
              onChange={(e) => updateSettings({ editorCommand: e.target.value })}
              placeholder="code"
            />
          </div>
        </div>
      </div>
    </>,
    document.body
  )
}
