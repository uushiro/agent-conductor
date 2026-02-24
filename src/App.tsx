import { useState, useEffect, useRef } from 'react'
import { Sidebar } from './components/Sidebar'
import { FileTreeSidebar } from './components/FileTreeSidebar'
import { TerminalTabs, type TerminalTabsHandle } from './components/TerminalTabs'
import { StatusBar } from './components/StatusBar'

export function App() {
  const [activeTabId, setActiveTabId] = useState<string>('')
  const [showQuitConfirm, setShowQuitConfirm] = useState(false)
  const [fileTreeVisible, setFileTreeVisible] = useState(true)
  const tabsRef = useRef<TerminalTabsHandle>(null)

  useEffect(() => {
    const offConfirm = window.electronAPI.onQuitConfirm(() => setShowQuitConfirm(true))
    const offCancel = window.electronAPI.onQuitConfirmCancel(() => setShowQuitConfirm(false))
    return () => { offConfirm(); offCancel() }
  }, [])

  return (
    <div className="app">
      {showQuitConfirm && (
        <div className="quit-confirm-toast">
          もう一度 <kbd>⌘Q</kbd> を押すと終了します
        </div>
      )}
      <div className="main-content">
        <Sidebar
          activeTabId={activeTabId}
          onTabSelect={setActiveTabId}
          onSendToAgent={(prompt, agent) => tabsRef.current?.sendToNewTab(prompt, agent)}
          fileTreeVisible={fileTreeVisible}
          onToggleFileTree={() => setFileTreeVisible((v) => !v)}
        />
        <FileTreeSidebar activeTabId={activeTabId} visible={fileTreeVisible} />
        <TerminalTabs ref={tabsRef} activeTabId={activeTabId} onActiveTabChange={setActiveTabId} />
      </div>
      <StatusBar />
    </div>
  )
}
