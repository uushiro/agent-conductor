import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useSettings, DefaultAgent, InputSendMode, InputSubmitMode, WidgetId, WidgetConfig, DEFAULT_WIDGETS } from '../contexts/SettingsContext'
import { useLang, strings } from '../contexts/LangContext'

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
  const { theme, fontSize, editorCommand, customEditors, accentColor, customColors, defaultAgent, inputSendMode, inputSubmitMode, sidebarWidgets, resumeProjectDirs, updateSettings } = useSettings()
  const { lang, toggleLang } = useLang()
  const t = strings[lang]
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

  const allEditors = [...PRESET_EDITORS]

  return createPortal(
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 899 }}
        onClick={onClose}
      />
      <div className="settings-modal">
        <div className="settings-header">
          <span className="settings-title">{t.settings}</span>
          <button className="settings-close" onClick={onClose}>×</button>
        </div>
        <div className="settings-body">
          <div className="settings-row">
            <label className="settings-label">{t.theme}</label>
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
            <label className="settings-label">{t.fontSize}</label>
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
            <label className="settings-label">{t.language}</label>
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
            <label className="settings-label">{t.accentColor}</label>
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

          <div className="settings-row">
            <label className="settings-label">{t.defaultAgent}</label>
            <div className="settings-toggle-group">
              {(['claude', 'gemini', 'codex'] as DefaultAgent[]).map((agent) => (
                <button
                  key={agent}
                  className={`settings-toggle-btn${defaultAgent === agent ? ' active' : ''}`}
                  onClick={() => updateSettings({ defaultAgent: agent })}
                >
                  {agent.charAt(0).toUpperCase() + agent.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-row">
            <label className="settings-label">Input Send</label>
            <div className="settings-toggle-group">
              {([
                { value: 'enter', label: 'Enter' },
                { value: 'button', label: 'Button' },
                { value: 'cmd-enter', label: 'Cmd+Enter' },
              ] as { value: InputSendMode; label: string }[]).map(({ value, label }) => (
                <button
                  key={value}
                  className={`settings-toggle-btn${inputSendMode === value ? ' active' : ''}`}
                  onClick={() => updateSettings({ inputSendMode: value })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-row">
            <label className="settings-label">Input Submit</label>
            <div className="settings-toggle-group">
              {([
                { value: 'direct', label: lang === 'ja' ? '直接実行' : 'Direct' },
                { value: 'paste', label: lang === 'ja' ? '貼り付け' : 'Paste' },
              ] as { value: InputSubmitMode; label: string }[]).map(({ value, label }) => (
                <button
                  key={value}
                  className={`settings-toggle-btn${inputSubmitMode === value ? ' active' : ''}`}
                  onClick={() => updateSettings({ inputSubmitMode: value })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-row settings-row-editor">
            <label className="settings-label">{t.editor}</label>
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
            </div>
          </div>

          {/* Sidebar Widgets */}
          <div className="settings-section-divider">Sidebar Widgets</div>
          <div className="settings-row settings-row-editor">
            <label className="settings-label">Widgets</label>
            <div className="settings-widget-list">
              {(sidebarWidgets ?? DEFAULT_WIDGETS).map((w, idx) => {
                const widgets = sidebarWidgets ?? DEFAULT_WIDGETS
                const LABEL: Record<WidgetId, string> = { sessions: 'Sessions', tasks: 'Tasks', resume: 'Resume' }
                return (
                  <div key={w.id} className="settings-widget-row">
                    <button
                      className={`settings-toggle-btn${w.enabled ? ' active' : ''}`}
                      style={{ minWidth: 70 }}
                      onClick={() => {
                        const next = widgets.map((x) => x.id === w.id ? { ...x, enabled: !x.enabled } : x)
                        updateSettings({ sidebarWidgets: next })
                      }}
                    >
                      {LABEL[w.id]}
                    </button>
                    <div className="settings-widget-arrows">
                      <button
                        className="settings-arrow-btn"
                        disabled={idx === 0}
                        onClick={() => {
                          const next = [...widgets]
                          ;[next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]
                          updateSettings({ sidebarWidgets: next })
                        }}
                      >▲</button>
                      <button
                        className="settings-arrow-btn"
                        disabled={idx === widgets.length - 1}
                        onClick={() => {
                          const next = [...widgets]
                          ;[next[idx], next[idx + 1]] = [next[idx + 1], next[idx]]
                          updateSettings({ sidebarWidgets: next })
                        }}
                      >▼</button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Resume project dirs */}
          <div className="settings-row settings-row-editor">
            <label className="settings-label">Resume Dirs</label>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>
                {(resumeProjectDirs ?? []).length === 0
                  ? 'All projects (default)'
                  : `${resumeProjectDirs.length} dir(s) selected`}
              </div>
              {(resumeProjectDirs ?? []).map((dir, idx) => (
                <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                  <span style={{ flex: 1, fontSize: 11, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dir}</span>
                  <button
                    className="settings-arrow-btn"
                    onClick={() => updateSettings({ resumeProjectDirs: (resumeProjectDirs ?? []).filter((_, i) => i !== idx) })}
                  >×</button>
                </div>
              ))}
              <button
                className="settings-editor-add-btn"
                onClick={async () => {
                  const paths = await window.electronAPI.openFileDialog()
                  if (paths && paths.length > 0) {
                    updateSettings({ resumeProjectDirs: [...(resumeProjectDirs ?? []), ...paths] })
                  }
                }}
              >+ Add dir</button>
            </div>
          </div>

        </div>
      </div>
    </>,
    document.body
  )
}
