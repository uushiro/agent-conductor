export interface TabInfo {
  id: string
  cwd: string
  proc: string
  issue: string
  latestInput: string
  claudeSessionId: string | null
  lastOutput: string
  active: boolean
  lastInputAt: number
  isThinking: boolean
}

export interface SavedSession {
  tabs: Array<{ issue: string; cwd: string; hadClaude: boolean; claudeSessionId: string | null }>
  activeIndex: number
}

export interface ElectronAPI {
  createTerminal: (cwd?: string, pendingSessionId?: string) => Promise<string>
  closeTerminal: (tabId: string) => void
  onTerminalData: (callback: (tabId: string, data: string) => void) => () => void
  sendTerminalInput: (tabId: string, data: string) => void
  resizeTerminal: (tabId: string, cols: number, rows: number) => void
  getTerminalTitle: (tabId: string) => Promise<{ issue: string; detail: string }>
  setTerminalIssue: (tabId: string, issue: string) => Promise<void>
  listTerminalInfo: () => Promise<TabInfo[]>
  loadSession: () => Promise<SavedSession | null>
  getGitBranch: () => Promise<string | null>
  getCwd: () => Promise<string>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
