import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  // Same-visible-tab Agent Conductor handoff
  getAgentSwitchState: (tabId: string) => ipcRenderer.invoke('terminal:agent-switch-state', tabId),
  switchAgent: (tabId: string, target: 'claude' | 'codex') =>
    ipcRenderer.invoke('terminal:switch-agent', tabId, target) as Promise<{ ok: boolean; error?: string }>,
  cancelAgentSwitch: (tabId: string) => ipcRenderer.invoke('terminal:cancel-agent-switch', tabId) as Promise<void>,
  getAgentSwitchRecovery: (tabId: string) => ipcRenderer.invoke('terminal:agent-switch-recovery', tabId),
  sendAgentSwitchRecoveryInput: (tabId: string, data: string) => ipcRenderer.invoke('terminal:agent-switch-recovery-input', tabId, data),
  resizeAgentSwitchRecovery: (tabId: string, cols: number, rows: number) => ipcRenderer.invoke('terminal:agent-switch-recovery-resize', tabId, cols, rows),
  getAgentSwitchMetrics: () => ipcRenderer.invoke('terminal:agent-switch-metrics'),
  acknowledgeAgentSwitchRender: (tabId: string, token: string) => ipcRenderer.send('terminal:agent-switch-rendered', tabId, token),
  onTerminalReset: (callback: (tabId: string, data: string, token?: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, tabId: string, data: string, token?: string) => callback(tabId, data, token)
    ipcRenderer.on('terminal:reset', listener)
    return () => ipcRenderer.removeListener('terminal:reset', listener)
  },
  // Terminal lifecycle
  createTerminal: (cwd?: string, pendingSessionId?: string, pendingAgent?: 'claude' | 'codex') =>
    ipcRenderer.invoke('terminal:create', cwd, pendingSessionId, pendingAgent) as Promise<string>,
  createWorktreeTerminal: (tabId: string, branchName?: string) =>
    ipcRenderer.invoke('terminal:create-worktree', tabId, branchName) as Promise<
      { ok: true; tabId: string; worktreePath: string; branch: string } | { ok: false; error: string }
    >,
  closeTerminal: (tabId: string) => {
    ipcRenderer.send('terminal:close', tabId)
  },

  // Terminal I/O (with tabId)
  onTerminalData: (callback: (tabId: string, data: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, tabId: string, data: string) =>
      callback(tabId, data)
    ipcRenderer.on('terminal:data', listener)
    return () => {
      ipcRenderer.removeListener('terminal:data', listener)
    }
  },
  sendTerminalInput: (tabId: string, data: string) => {
    ipcRenderer.send('terminal:input', tabId, data)
  },
  sendChoice: (tabId: string, num: string) =>
    ipcRenderer.invoke('terminal:send-choice', tabId, num) as Promise<void>,
  resizeTerminal: (tabId: string, cols: number, rows: number) => {
    ipcRenderer.send('terminal:resize', tabId, cols, rows)
  },

  // Tab title (poll) + issue rename
  getTerminalTitle: (tabId: string) =>
    ipcRenderer.invoke('terminal:get-title', tabId) as Promise<{ issue: string; detail: string; model: string | null; activeAgents: Array<{ label: string; model: string; status: 'started' | 'done'; doneAt?: number }>; agentStatus: 'error' | 'running' | 'attention' | 'waiting' | 'done' | 'none'; promptChoices: Array<{ num: string; label: string }> }>,
  setTerminalIssue: (tabId: string, issue: string, persistSessionTitle?: boolean) =>
    ipcRenderer.invoke('terminal:set-issue', tabId, issue, persistSessionTitle),

  // Tab info (for sidebar)
  listTerminalInfo: () =>
    ipcRenderer.invoke('terminal:list-info') as Promise<
      Array<{ id: string; cwd: string; proc: string; issue: string; latestInput: string; claudeSessionId: string | null; lastOutput: string; active: boolean; model: string | null; activeAgents: Array<{ label: string; model: string; status: 'started' | 'done'; doneAt?: number }>; agentStatus: 'error' | 'running' | 'attention' | 'waiting' | 'done' | 'none'; promptChoices: Array<{ num: string; label: string }> }>
    >,

  // Close confirmation + restore history
  getTabHasClaude: (tabId: string) =>
    ipcRenderer.invoke('terminal:get-tab-has-claude', tabId) as Promise<boolean>,
  getClosedHistory: () =>
    ipcRenderer.invoke('terminal:get-closed-history') as Promise<Array<{ issue: string; cwd: string; claudeSessionId: string | null; closedAt: number; model: string | null }>>,
  removeClosedHistory: (sessionId: string) => {
    ipcRenderer.send('terminal:remove-closed-history', sessionId)
  },

  // Tab reorder
  reorderTerminals: (tabIds: string[]) => {
    ipcRenderer.send('terminal:reorder', tabIds)
  },

  // Session persistence
  loadSession: () =>
    ipcRenderer.invoke('session:load') as Promise<{ tabs: Array<{ issue: string; cwd: string; hadClaude: boolean; claudeSessionId: string | null; model: string | null }>; activeIndex: number } | null>,

  // Agent-to-agent message notifications ([[SEND: dest :: body]] routing results)
  onAgentMsgNotify: (cb: (payload: { type: 'queued' | 'delivered' | 'error'; from: string; dest: string; body: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { type: 'queued' | 'delivered' | 'error'; from: string; dest: string; body: string }) => cb(payload)
    ipcRenderer.on('agent-msg:notify', listener)
    return () => ipcRenderer.removeListener('agent-msg:notify', listener)
  },

  // Quit confirmation
  onQuitConfirm: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('quit-confirm', listener)
    return () => ipcRenderer.removeListener('quit-confirm', listener)
  },
  onQuitConfirmCancel: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('quit-confirm-cancel', listener)
    return () => ipcRenderer.removeListener('quit-confirm-cancel', listener)
  },

  // System info
  getGitBranch: () => ipcRenderer.invoke('git:branch'),
  getCwd: () => ipcRenderer.invoke('system:cwd'),

  // File tree
  listDir: (dirPath: string) =>
    ipcRenderer.invoke('fs:list-dir', dirPath) as Promise<
      Array<{ name: string; path: string; isDir: boolean }>
    >,
  openInEditor: (filePath: string, editorCommand?: string) =>
    ipcRenderer.invoke('fs:open-in-editor', filePath, editorCommand) as Promise<void>,
  writeClipboard: (text: string) => ipcRenderer.invoke('clipboard:write', text),

  // Update notifications
  onUpdateAvailable: (cb: (version: string, url: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, version: string, url: string) => cb(version, url)
    ipcRenderer.on('update:available', listener)
    return () => ipcRenderer.removeListener('update:available', listener)
  },
  openExternal: (url: string) => ipcRenderer.send('shell:open-url', url),

  // Settings persistence (file-based, more reliable than localStorage in Electron)
  loadAppSettings: () => ipcRenderer.invoke('settings:load') as Promise<Record<string, unknown> | null>,
  saveAppSettings: (data: string) => ipcRenderer.send('settings:save', data),
  openFileDialog: () => ipcRenderer.invoke('dialog:open-file') as Promise<string[]>,
  writeClipboardImage: (filePath: string) => ipcRenderer.invoke('clipboard:write-image', filePath) as Promise<boolean>,
  saveClipboardImage: (filePath: string) => ipcRenderer.invoke('clipboard:save-image', filePath) as Promise<boolean>,
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  // Route through the main process via IPC. Calling clipboard.writeText()
  // directly inside the sandboxed preload corrupts multi-byte UTF-8
  // (ASCII ok / mixed garbled / CJK-only empty). Main runs it in full Node.
  copyToClipboard: (text: string) => ipcRenderer.invoke('clipboard:write', text),
  pasteToWindow: () => ipcRenderer.invoke('window:paste'),
  listResumeSessions: (projectDirs: string[] | null) =>
    ipcRenderer.invoke('resume:list-sessions', projectDirs) as Promise<Array<{
      id: string; title: string; automaticTitle: string; hasCustomTitle: boolean; projectDir: string; updatedAt: number; sizeBytes: number
      agent: 'claude' | 'codex'; cwd?: string
    }>>,
  setResumeSessionTitle: (agent: 'claude' | 'codex', sessionId: string, title: string | null) =>
    ipcRenderer.invoke('resume:set-title-override', agent, sessionId, title) as Promise<boolean>,
})
