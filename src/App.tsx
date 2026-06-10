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
  // Split view: panes[0] = left pane tab, panes[1] = right pane tab (null = single pane)
  const [panes, setPanes] = useState<[string, string | null]>(['', null])
  // focusedPane: which pane "activeTabId" refers to (last-focused pane)
  const [focusedPane, setFocusedPane] = useState<0 | 1>(0)
  const focusedPaneRef = useRef(focusedPane)
  focusedPaneRef.current = focusedPane
  const panesRef = useRef(panes)
  panesRef.current = panes
  // Remembered split pair (Chrome-style). `panes` is what is currently displayed;
  // the pair survives while a non-pair tab is shown solo, so clicking a pair tab
  // restores the split. Cleared by removeFromSplit / closeRightPane / closing a pair tab.
  const splitPairRef = useRef<[string, string] | null>(null)
  const activeTabId = focusedPane === 1 && panes[1] !== null ? panes[1] : panes[0]
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

  // Select a tab (tab bar click / Cmd+1-9 / terminal focus), Chrome-style:
  // - tab belongs to the remembered split pair → show the pair (restore split) and focus its pane
  // - otherwise → show the tab alone, full width (the pair stays remembered)
  const selectTab = useCallback((tabId: string) => {
    if (!tabId) return
    const pair = splitPairRef.current
    if (pair && (tabId === pair[0] || tabId === pair[1])) {
      setPanes((prev) => (prev[0] === pair[0] && prev[1] === pair[1] ? prev : [pair[0], pair[1]]))
      setFocusedPane(tabId === pair[0] ? 0 : 1)
      return
    }
    setPanes((prev) => (prev[0] === tabId && prev[1] === null ? prev : [tabId, null]))
    setFocusedPane(0)
  }, [])

  // Add a tab to the split view (Chrome-style「新しい分割ビューにタブを追加」):
  // - already shown in a pane → just focus that pane
  // - single view → show it next to the current tab (right pane)
  // - split view → it replaces the partner of the focused pane
  const addToSplit = useCallback((tabId: string) => {
    const [left, right] = panesRef.current
    if (tabId === left || tabId === right) {
      setFocusedPane(tabId === left ? 0 : 1)
      return
    }
    if (right === null || focusedPaneRef.current === 0) {
      splitPairRef.current = [left, tabId]
      setPanes([left, tabId])
      setFocusedPane(1)
    } else {
      splitPairRef.current = [tabId, right]
      setPanes([tabId, right])
      setFocusedPane(0)
    }
  }, [])

  // Remove a tab from the split view (Chrome-style「分割ビューから削除」):
  // the other pane's tab remains shown alone. The pair memory is dissolved.
  const removeFromSplit = useCallback((tabId: string) => {
    const [left, right] = panesRef.current
    if (right === null) return
    if (tabId === left) setPanes([right, null])
    else if (tabId === right) setPanes([left, null])
    else return
    splitPairRef.current = null
    setFocusedPane(0)
  }, [])

  // Close the right pane (back to single view). The pair memory is dissolved.
  const closeRightPane = useCallback(() => {
    splitPairRef.current = null
    setPanes((prev) => (prev[1] === null ? prev : [prev[0], null]))
    setFocusedPane(0)
  }, [])

  // A tab was closed: repair pane assignments (fallbackId = neighbor tab chosen by TerminalTabs)
  const handleTabRemoved = useCallback((tabId: string, fallbackId: string) => {
    const pair = splitPairRef.current
    if (pair && (pair[0] === tabId || pair[1] === tabId)) {
      // A pair member was closed → dissolve the pair memory
      splitPairRef.current = null
    }
    setPanes((prev) => {
      let [left, right] = prev
      if (right === tabId) {
        right = null
        setFocusedPane(0)
      }
      if (left === tabId) {
        if (right !== null && fallbackId === right) {
          // The only sensible fallback is the right-pane tab → promote it to left, unsplit
          left = right
          right = null
        } else {
          left = fallbackId
        }
        setFocusedPane(0)
      }
      if (left === prev[0] && right === prev[1]) return prev
      return [left, right]
    })
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
          onTabSelect={selectTab}
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
          <TerminalTabs
            ref={tabsRef}
            activeTabId={activeTabId}
            panes={panes}
            focusedPane={focusedPane}
            onActiveTabChange={selectTab}
            onAddToSplit={addToSplit}
            onRemoveFromSplit={removeFromSplit}
            onCloseRightPane={closeRightPane}
            onTabRemoved={handleTabRemoved}
          />
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
