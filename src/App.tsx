import { useState, useEffect, useRef, useCallback } from 'react'
import { useLang, strings } from './contexts/LangContext'
import { useSettings } from './contexts/SettingsContext'
import { SplashScreen } from './components/SplashScreen'
import { Sidebar } from './components/Sidebar'
import { FileTreeSidebar } from './components/FileTreeSidebar'
import { TerminalTabs, type TerminalTabsHandle } from './components/TerminalTabs'
import { StatusBar } from './components/StatusBar'
import { FloatingInput } from './components/FloatingInput'

export function App() {
  const { lang } = useLang()
  const { fileTreeVisible, updateSettings, loaded } = useSettings()
  const [activeTabId, setActiveTabId] = useState<string>('')
  const [showQuitConfirm, setShowQuitConfirm] = useState(false)
  const [showFloatingInput, setShowFloatingInput] = useState(
    () => localStorage.getItem('input-bar-open') !== 'false'
  )
  const [inputBarHeight, setInputBarHeight] = useState(100)
  const [tabBottom, setTabBottom] = useState(0)
  const tabTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tabsRef = useRef<TerminalTabsHandle>(null)

  const [sidebarWidth, setSidebarWidth] = useState(() =>
    Number(localStorage.getItem('sidebar-width')) || 260
  )
  const [fileTreeWidth, setFileTreeWidth] = useState(() =>
    Number(localStorage.getItem('filetree-width')) || 260
  )
  const sidebarWidthRef = useRef(sidebarWidth)
  const fileTreeWidthRef = useRef(fileTreeWidth)
  sidebarWidthRef.current = sidebarWidth
  fileTreeWidthRef.current = fileTreeWidth

  useEffect(() => {
    localStorage.setItem('sidebar-width', String(sidebarWidth))
  }, [sidebarWidth])

  useEffect(() => {
    localStorage.setItem('filetree-width', String(fileTreeWidth))
  }, [fileTreeWidth])

  useEffect(() => {
    const offConfirm = window.electronAPI.onQuitConfirm(() => setShowQuitConfirm(true))
    const offCancel = window.electronAPI.onQuitConfirmCancel(() => setShowQuitConfirm(false))
    return () => { offConfirm(); offCancel() }
  }, [])

  // Sync tabBottom with showFloatingInput (delay on close) + persist state
  useEffect(() => {
    localStorage.setItem('input-bar-open', String(showFloatingInput))
    if (tabTimerRef.current) clearTimeout(tabTimerRef.current)
    if (showFloatingInput) {
      setTabBottom(inputBarHeight)
    } else {
      tabTimerRef.current = setTimeout(() => setTabBottom(0), 100)
    }
    return () => { if (tabTimerRef.current) clearTimeout(tabTimerRef.current) }
  }, [showFloatingInput, inputBarHeight])

  // Cmd+Shift+I toggles floating input
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && e.key === 'i') {
        e.preventDefault()
        setShowFloatingInput((prev) => !prev)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  const handleSidebarResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = sidebarWidthRef.current
    const onMove = (me: MouseEvent) => {
      setSidebarWidth(Math.max(160, Math.min(520, startW + me.clientX - startX)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  const handleFileTreeResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = fileTreeWidthRef.current
    const onMove = (me: MouseEvent) => {
      setFileTreeWidth(Math.max(160, Math.min(520, startW + me.clientX - startX)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  // Remove the HTML splash once React+settings are ready
  useEffect(() => {
    if (!loaded) return
    const el = document.getElementById('splash')
    if (!el) return
    el.style.transition = 'opacity 0.3s ease'
    el.style.opacity = '0'
    setTimeout(() => el.remove(), 300)
  }, [loaded])

  return (
    <div className="app">
      {showQuitConfirm && (
        <div className="quit-confirm-toast">
          {strings[lang].quitConfirm}
        </div>
      )}
      <div className="main-content">
        <Sidebar
          activeTabId={activeTabId}
          onTabSelect={setActiveTabId}
          onSendToAgent={(prompt, agent) => tabsRef.current?.sendToNewTab(prompt, agent)}
          onResumeSession={(sessionId) => tabsRef.current?.resumeSession(sessionId)}
          fileTreeVisible={fileTreeVisible}
          onToggleFileTree={() => updateSettings({ fileTreeVisible: !fileTreeVisible })}
          width={sidebarWidth}
        />
        <div className="resize-handle" onMouseDown={handleSidebarResize} />
        <FileTreeSidebar activeTabId={activeTabId} visible={fileTreeVisible} width={fileTreeWidth} />
        {fileTreeVisible && (
          <div className="resize-handle" onMouseDown={handleFileTreeResize} />
        )}
        <div className="terminal-column">
          <TerminalTabs ref={tabsRef} activeTabId={activeTabId} onActiveTabChange={setActiveTabId} />
          <div style={{
            height: showFloatingInput ? inputBarHeight : 0,
            overflow: 'hidden',
            transition: 'height 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
            flexShrink: 0,
          }}>
            <FloatingInput
              activeTabId={activeTabId}
              visible={showFloatingInput}
              onClose={() => setShowFloatingInput(false)}
              onHeightChange={setInputBarHeight}
              onToggle={() => setShowFloatingInput((v) => !v)}
            />
          </div>
          <button
            className={`terminal-input-tab${showFloatingInput ? ' terminal-input-tab--open' : ''}`}
            style={{ bottom: tabBottom + 6 }}
            onClick={() => setShowFloatingInput((v) => !v)}
            title={showFloatingInput ? '閉じる (⌘⇧I)' : '入力欄を開く (⌘⇧I)'}
          >
            {showFloatingInput
              ? <span className="tab-icon-close">⌄</span>
              : <span className="tab-icon-open">✎</span>
            }
          </button>
        </div>
      </div>
      <StatusBar />
    </div>
  )
}
