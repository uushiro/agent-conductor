import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  // Terminal lifecycle
  createTerminal: (cwd?: string) => ipcRenderer.invoke('terminal:create', cwd) as Promise<string>,
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
  resizeTerminal: (tabId: string, cols: number, rows: number) => {
    ipcRenderer.send('terminal:resize', tabId, cols, rows)
  },

  // Tab title (poll) + issue rename
  getTerminalTitle: (tabId: string) =>
    ipcRenderer.invoke('terminal:get-title', tabId) as Promise<{ issue: string; detail: string }>,
  setTerminalIssue: (tabId: string, issue: string) =>
    ipcRenderer.invoke('terminal:set-issue', tabId, issue),

  // Tab info (for sidebar)
  listTerminalInfo: () =>
    ipcRenderer.invoke('terminal:list-info') as Promise<
      Array<{ id: string; cwd: string; proc: string; issue: string; latestInput: string; claudeSessionId: string | null; lastOutput: string; active: boolean }>
    >,

  // Session persistence
  loadSession: () =>
    ipcRenderer.invoke('session:load') as Promise<{ tabs: Array<{ issue: string; cwd: string }>; activeIndex: number } | null>,

  // System info
  getGitBranch: () => ipcRenderer.invoke('git:branch'),
  getCwd: () => ipcRenderer.invoke('system:cwd'),
})
