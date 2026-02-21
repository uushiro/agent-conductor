import { Sidebar } from './components/Sidebar'
import { TerminalTabs } from './components/TerminalTabs'
import { StatusBar } from './components/StatusBar'

export function App() {
  return (
    <div className="app">
      <div className="main-content">
        <Sidebar />
        <TerminalTabs />
      </div>
      <StatusBar />
    </div>
  )
}
