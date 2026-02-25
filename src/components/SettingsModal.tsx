import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useSettings } from '../contexts/SettingsContext'
import { useLang } from '../contexts/LangContext'

interface Props {
  onClose: () => void
}

const PRESET_COLORS = [
  { label: 'Red', value: '#e8383d' },
  { label: 'Orange', value: '#f5a623' },
  { label: 'Yellow', value: '#ffd700' },
  { label: 'Green', value: '#2ecc71' },
  { label: 'Blue', value: '#58a6ff' },
  { label: 'Purple', value: '#9b59b6' },
  { label: 'Pink', value: '#ff69b4' },
]

const PRESET_EDITORS = [
  { label: 'macOS Default', value: '' },
  { label: 'code', value: 'code' },
  { label: 'cursor', value: 'cursor' },
  { label: 'vim', value: 'vim' },
  { label: 'nvim', value: 'nvim' },
  { label: 'subl', value: 'subl' },
]

export function SettingsModal({ onClose }: Props) {
  const { theme, fontSize, editorCommand, customEditors, accentColor, customColors, updateSettings } = useSettings()
  const { lang, toggleLang } = useLang()
  const [addingEditor, setAddingEditor] = useState(false)
  const [addEditorValue, setAddEditorValue] = useState('')
  const [addingColor, setAddingColor] = useState(false)
  const [addColorValue, setAddColorValue] = useState('')
  const addInputRef = useRef<HTMLInputElement>(null)
  const addColorRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (addingEditor) addInputRef.current?.focus()
  }, [addingEditor])

  useEffect(() => {
    if (addingColor) addColorRef.current?.focus()
  }, [addingColor])

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

  const handleAddColor = () => {
    const val = addColorValue.trim()
    if (val && /^#[0-9a-fA-F]{3,8}$/.test(val)) {
      const isPreset = PRESET_COLORS.some((p) => p.value.toLowerCase() === val.toLowerCase())
      const isCustom = customColors.includes(val)
      if (!isPreset && !isCustom) {
        updateSettings({ customColors: [...customColors, val], accentColor: val })
      } else {
        updateSettings({ accentColor: val })
      }
    }
    setAddColorValue('')
    setAddingColor(false)
  }

  const allColors = [
    ...PRESET_COLORS,
    ...customColors.map((v) => ({ label: v, value: v })),
  ]

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
            <label className="settings-label">Accent Color</label>
            <div className="settings-editor-chips">
              {allColors.map(({ label, value }) => (
                <button
                  key={value}
                  className={`settings-color-chip${accentColor === value ? ' active' : ''}`}
                  onClick={() => updateSettings({ accentColor: value })}
                  title={label}
                  style={{ '--chip-color': value } as React.CSSProperties}
                >
                  <span className="settings-color-dot" />
                  {label}
                </button>
              ))}
              {addingColor ? (
                <input
                  ref={addColorRef}
                  className="settings-editor-add-input"
                  value={addColorValue}
                  onChange={(e) => setAddColorValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddColor()
                    if (e.key === 'Escape') { setAddingColor(false); setAddColorValue('') }
                  }}
                  onBlur={() => { setAddingColor(false); setAddColorValue('') }}
                  placeholder="#hex..."
                />
              ) : (
                <button
                  className="settings-editor-add-btn"
                  onClick={() => setAddingColor(true)}
                  title="Add custom color"
                >
                  +
                </button>
              )}
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

          <div className="settings-divider" />

          <details className="settings-help">
            <summary className="settings-help-summary">Help</summary>
            <div className="settings-help-body">
              <p><strong>Tabs</strong>: + to add (Claude/Gemini/Terminal). Double-click tab to rename. Drag to reorder. ↺ to restore closed tabs.</p>
              <p><strong>Sessions</strong>: Auto-saved on quit, auto-resumed on launch. "Resuming..." shown while restoring.</p>
              <p><strong>Sidebar</strong>: Session list with status dots (green=active). Task list below — add tasks, check to complete, double-click to edit. ▶ sends task to new agent tab.</p>
              <p><strong>Tasks from Claude</strong>: Include <code>[[TASK: title]]</code> in Claude output to auto-add tasks.</p>
              <p><strong>File Tree</strong>: Toggle with ▤. Auto-follows active tab's cwd. Click path to pin a directory. Right-click files for context menu.</p>
              <p><strong>Terminal</strong>: Select text + Backspace to bulk-delete. Column widths are draggable and persisted.</p>
            </div>
          </details>
        </div>
      </div>
    </>,
    document.body
  )
}
