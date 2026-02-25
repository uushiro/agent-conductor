import { useState, useEffect, useRef, useCallback } from 'react'
import { useLang, strings } from './contexts/LangContext'
import { Sidebar } from './components/Sidebar'
import { FileTreeSidebar } from './components/FileTreeSidebar'
import { TerminalTabs, type TerminalTabsHandle } from './components/TerminalTabs'
import { StatusBar } from './components/StatusBar'

export function App() {
  const { lang } = useLang()
  const [activeTabId, setActiveTabId] = useState<string>('')
  const [showQuitConfirm, setShowQuitConfirm] = useState(false)
  const [fileTreeVisible, setFileTreeVisible] = useState(true)
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
          fileTreeVisible={fileTreeVisible}
          onToggleFileTree={() => setFileTreeVisible((v) => !v)}
          width={sidebarWidth}
        />
        <div className="resize-handle" onMouseDown={handleSidebarResize} />
        <FileTreeSidebar activeTabId={activeTabId} visible={fileTreeVisible} width={fileTreeWidth} />
        {fileTreeVisible && (
          <div className="resize-handle" onMouseDown={handleFileTreeResize} />
        )}
        <TerminalTabs ref={tabsRef} activeTabId={activeTabId} onActiveTabChange={setActiveTabId} />
      </div>
      <StatusBar />
    </div>
  )
}
