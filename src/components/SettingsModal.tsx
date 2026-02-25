import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useSettings } from '../contexts/SettingsContext'
import { useLang } from '../contexts/LangContext'

interface Props {
  onClose: () => void
}

const PRESET_EDITORS = [
  { label: 'macOS Default', value: '' },
  { label: 'code', value: 'code' },
  { label: 'cursor', value: 'cursor' },
  { label: 'vim', value: 'vim' },
  { label: 'nvim', value: 'nvim' },
  { label: 'subl', value: 'subl' },
]

export function SettingsModal({ onClose }: Props) {
  const { theme, fontSize, editorCommand, customEditors, updateSettings } = useSettings()
  const { lang, toggleLang } = useLang()
  const [addingEditor, setAddingEditor] = useState(false)
  const [addEditorValue, setAddEditorValue] = useState('')
  const addInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (addingEditor) addInputRef.current?.focus()
  }, [addingEditor])

  const handleAddEditor = () => {
    const val = addEditorValue.trim()
    if (val) {
      const isPreset = PRESET_EDITORS.some((p) => p.value === val)
      const isCustom = customEditors.includes(val)
      if (!isPreset && !isCustom) {
        updateSettings({ customEditors: [...customEditors, val], editorCommand: val })
      } else {
        updateSettings({ editorCommand: val })
      }
    }
    setAddEditorValue('')
    setAddingEditor(false)
  }

  const allEditors = [
    ...PRESET_EDITORS,
    ...customEditors.map((v) => ({ label: v, value: v })),
  ]

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

          <div className="settings-row settings-row-editor">
            <label className="settings-label">Editor</label>
            <div className="settings-editor-chips">
              {allEditors.map(({ label, value }) => (
                <button
                  key={value || '__default__'}
                  className={`settings-toggle-btn${editorCommand === value ? ' active' : ''}`}
                  onClick={() => updateSettings({ editorCommand: value })}
                >
                  {label}
                </button>
              ))}
              {addingEditor ? (
                <input
                  ref={addInputRef}
                  className="settings-editor-add-input"
                  value={addEditorValue}
                  onChange={(e) => setAddEditorValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddEditor()
                    if (e.key === 'Escape') { setAddingEditor(false); setAddEditorValue('') }
                  }}
                  onBlur={() => { setAddingEditor(false); setAddEditorValue('') }}
                  placeholder="command..."
                />
              ) : (
                <button
                  className="settings-editor-add-btn"
                  onClick={() => setAddingEditor(true)}
                  title="Add custom editor"
                >
                  +
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </>,
    document.body
  )
}
