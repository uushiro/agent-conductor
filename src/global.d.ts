export interface FileEntry {
  name: string
  path: string
  isDir: boolean
}

export interface ClosedTabEntry {
  issue: string
  cwd: string
  claudeSessionId: string | null
  codexSessionId: string | null
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
// 'error' (red blinking, critical API/auth error needs a human NOW) /
// 'running' (blue) / 'attention' (yellow blinking, a select prompt awaits an answer) /
// 'waiting' (purple, quiet but no prompt detected) / 'done' (green) / 'none'
export type TabAgentStatus = 'error' | 'running' | 'attention' | 'waiting' | 'done' | 'none'

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
  tabs: Array<{ handoff?: unknown; issue: string; cwd: string; hadClaude: boolean; claudeSessionId: string | null; hadGemini: boolean; hadCodex: boolean; codexSessionId: string | null; model: string | null }>
  activeIndex: number
}

export interface ElectronAPI {
  getAgentSwitchState: (tabId: string) => Promise<{
    agent: 'claude' | 'codex' | null
    phase: 'idle' | 'preparing' | 'error'
    canSwitch: boolean
    reason: string
    target: 'claude' | 'codex' | null
    history: Array<{ agent: 'claude' | 'codex'; text: string }>
    progress: {
      stage: 'reading' | 'starting' | 'waiting'
      startedAt: number
      stageStartedAt: number
      elapsedMs: number
    } | null
    errorCode: string | null
    recovery: { agent: 'claude' | 'codex'; exited: boolean } | null
    lastAttempt: AgentSwitchAttempt | null
  }>
  switchAgent: (tabId: string, target: 'claude' | 'codex') => Promise<{ ok: boolean; error?: string }>
  cancelAgentSwitch: (tabId: string) => Promise<void>
  getAgentSwitchRecovery: (tabId: string) => Promise<{ agent: 'claude' | 'codex'; exited: boolean; output: string } | null>
  sendAgentSwitchRecoveryInput: (tabId: string, data: string) => Promise<boolean>
  resizeAgentSwitchRecovery: (tabId: string, cols: number, rows: number) => Promise<boolean>
  getAgentSwitchMetrics: () => Promise<AgentSwitchAttempt[]>
  getHandoffDraft: (tabId: string) => Promise<{ text: string; revision: number }>
  setHandoffDraft: (tabId: string, text: string) => Promise<{ text: string; revision: number }>
  getHandoffDraftDestination: (tabId: string) => Promise<{ ready: boolean; agent: 'claude' | 'codex' | null; token: string; reason?: string }>
  submitHandoffDraft: (tabId: string, revision: number, destination: string, submit?: boolean) => Promise<{ ok: boolean; error?: string; draft?: { text: string; revision: number } }>
  restoreHandoffSession: (tabId: string, lineage: unknown) => Promise<{ ok: boolean; errorCode?: string; reason?: string }>
  getAgentSwitchContext: (tabId: string) => Promise<{ text: string; stats: { turnCount: number; omittedReceipts: number; truncated: boolean; droppedTurns: number; retainedUnknown: number }; ready: boolean; reason: string }>
  acknowledgeAgentSwitchRender: (tabId: string, renderToken: string) => void
  onTerminalReset: (callback: (tabId: string, data: string, renderToken?: string) => void) => () => void
  createTerminal: (cwd?: string, pendingSessionId?: string, pendingAgent?: 'claude' | 'codex') => Promise<string>
  createWorktreeTerminal: (tabId: string, branchName?: string) => Promise<
    { ok: true; tabId: string; worktreePath: string; branch: string } | { ok: false; error: string }
  >
  closeTerminal: (tabId: string) => void
  onTerminalData: (callback: (tabId: string, data: string) => void) => () => void
  sendTerminalInput: (tabId: string, data: string, requireUnswitched?: boolean) => void
  sendChoice: (tabId: string, num: string) => Promise<void>
  resizeTerminal: (tabId: string, cols: number, rows: number) => void
  getTerminalTitle: (tabId: string) => Promise<{ issue: string; detail: string; model: string | null; activeAgents: ActiveAgent[]; agentStatus: TabAgentStatus; promptChoices: PromptChoice[] }>
  setTerminalIssue: (tabId: string, issue: string, persistSessionTitle?: boolean) => Promise<void>
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
    id: string; title: string; automaticTitle: string; hasCustomTitle: boolean; projectDir: string; updatedAt: number; sizeBytes: number
    agent: 'claude' | 'codex'; cwd?: string
  }>>
  setResumeSessionTitle: (agent: 'claude' | 'codex', sessionId: string, title: string | null) => Promise<boolean>
}

export interface AgentSwitchAttempt {
  from: 'claude' | 'codex' | null
  to: 'claude' | 'codex' | null
  mode: 'new' | 'reuse'
  outcome: 'success' | 'cancelled' | 'failed'
  errorCode: string | null
  startedAt: number
  durations: {
    readMs: number
    startMs: number
    waitMs: number
    activateMs: number
    totalMs: number
    rendererMs?: number | null
  }
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
