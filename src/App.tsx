import { useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { TerminalTabs } from './components/TerminalTabs'
import { StatusBar } from './components/StatusBar'

export function App() {
  const [activeTabId, setActiveTabId] = useState<string>('')

  return (
    <div className="app">
      <div className="main-content">
        <Sidebar activeTabId={activeTabId} onTabSelect={setActiveTabId} />
        <TerminalTabs activeTabId={activeTabId} onActiveTabChange={setActiveTabId} />
      </div>
      <StatusBar />
    </div>
  )
}
