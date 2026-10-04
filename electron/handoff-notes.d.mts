export interface SessionNoteSource {
  agent?: 'claude' | 'codex';
  sessionId?: string;
  path?: string;
  text?: string;
  toolInputs?: Array<{ name?: string; input?: { file_path?: string } }>;
  records?: Array<{ message?: { content?: Array<{ type?: string; name?: string; input?: { file_path?: string } }> } }>;
}
export interface SessionNote { path: string; truncated: boolean; }
export interface SessionNotesResult { text: string; notes: SessionNote[]; status: 'found' | 'none' | 'unavailable' | 'partial'; warnings: string[]; }
export function findSessionNotes(input: { home: string; sources: SessionNoteSource[]; vaultDir?: string }): Promise<SessionNotesResult>;
