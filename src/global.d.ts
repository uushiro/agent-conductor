export interface FileEntry {
  name: string
  path: string
  isDir: boolean
}

export interface ClosedTabEntry {
  issue: string
  cwd: string
  claudeSessionId: string | null
  agent: 'claude' | 'gemini' | 'codex'
  closedAt: number
  model: string | null
}

// In-tab worker agent reported via [[AGENT: label :: model :: started|done]] markers.
// done entries linger for a short window (doneAt) so completion stays visible.
export interface ActiveAgent {
  label: string
  model: string
  status: 'started' | 'done'
  doneAt?: number
}

// Aggregate per-tab agent status (tab-bar color coding):
// 'running' (blue) / 'attention' (yellow blinking, a select prompt awaits an answer) /
// 'waiting' (purple, quiet but no prompt detected) / 'done' (green) / 'none'
export type TabAgentStatus = 'running' | 'attention' | 'waiting' | 'done' | 'none'

// A numbered choice offered by an agent CLI select prompt (e.g. "❯ 1. Yes / 2. No").
// Extracted in main.ts only while the tab is waiting for input; empty otherwise.
export interface PromptChoice {
  num: string
  label: string
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
  isResuming: boolean
  model: string | null
  activeAgents: ActiveAgent[]
  agentStatus: TabAgentStatus
  promptChoices: PromptChoice[]
}

export interface SavedSession {
  tabs: Array<{ issue: string; cwd: string; hadClaude: boolean; claudeSessionId: string | null; hadGemini: boolean; hadCodex: boolean; model: string | null }>
  activeIndex: number
}

export interface ElectronAPI {
  createTerminal: (cwd?: string, pendingSessionId?: string) => Promise<string>
  createWorktreeTerminal: (tabId: string, branchName?: string) => Promise<
    { ok: true; tabId: string; worktreePath: string; branch: string } | { ok: false; error: string }
  >
  closeTerminal: (tabId: string) => void
  onTerminalData: (callback: (tabId: string, data: string) => void) => () => void
  sendTerminalInput: (tabId: string, data: string) => void
  sendChoice: (tabId: string, num: string) => Promise<void>
  resizeTerminal: (tabId: string, cols: number, rows: number) => void
  getTerminalTitle: (tabId: string) => Promise<{ issue: string; detail: string; model: string | null; activeAgents: ActiveAgent[]; agentStatus: TabAgentStatus; promptChoices: PromptChoice[] }>
  setTerminalIssue: (tabId: string, issue: string) => Promise<void>
  listTerminalInfo: () => Promise<TabInfo[]>
  getTabHasClaude: (tabId: string) => Promise<boolean>
  reorderTerminals: (tabIds: string[]) => void
  getClosedHistory: () => Promise<ClosedTabEntry[]>
  removeClosedHistory: (sessionId: string) => void
  loadSession: () => Promise<SavedSession | null>
  onAgentMsgNotify: (cb: (payload: { type: 'queued' | 'delivered' | 'error'; from: string; dest: string; body: string }) => void) => () => void
  onQuitConfirm: (cb: () => void) => () => void
  onQuitConfirmCancel: (cb: () => void) => () => void
  getGitBranch: () => Promise<string | null>
  getCwd: () => Promise<string>
  listDir: (dirPath: string) => Promise<FileEntry[]>
  openInEditor: (filePath: string, editorCommand?: string) => Promise<void>
  writeClipboard: (text: string) => Promise<void>
  copyToClipboard: (text: string) => Promise<void>
  onUpdateAvailable: (cb: (version: string, url: string) => void) => () => void
  openExternal: (url: string) => void
  loadAppSettings: () => Promise<Record<string, unknown> | null>
  saveAppSettings: (data: string) => void
  openFileDialog: () => Promise<string[]>
  writeClipboardImage: (filePath: string) => Promise<boolean>
  saveClipboardImage: (filePath: string) => Promise<boolean>
  getPathForFile: (file: File) => string
  pasteToWindow: () => Promise<void>
  listResumeSessions: (projectDirs: string[] | null) => Promise<Array<{
    id: string; title: string; projectDir: string; updatedAt: number; sizeBytes: number
  }>>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
