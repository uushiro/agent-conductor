export interface FileEntry {
  name: string
  path: string
  isDir: boolean
}

export interface ClosedTabEntry {
  issue: string
  cwd: string
  claudeSessionId: string | null
  agent: 'claude' | 'gemini'
  closedAt: number
}

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
  tabs: Array<{ issue: string; cwd: string; hadClaude: boolean; claudeSessionId: string | null; hadGemini: boolean }>
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
  getTabHasClaude: (tabId: string) => Promise<boolean>
  reorderTerminals: (tabIds: string[]) => void
  getClosedHistory: () => Promise<ClosedTabEntry[]>
  removeClosedHistory: (sessionId: string) => void
  loadSession: () => Promise<SavedSession | null>
  onTaskAdd: (cb: (title: string) => void) => () => void
  onTaskSetAll: (cb: (tasksJson: string) => void) => () => void
  onQuitConfirm: (cb: () => void) => () => void
  onQuitConfirmCancel: (cb: () => void) => () => void
  getGitBranch: () => Promise<string | null>
  getCwd: () => Promise<string>
  listDir: (dirPath: string) => Promise<FileEntry[]>
  openInEditor: (filePath: string) => Promise<void>
  writeClipboard: (text: string) => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
