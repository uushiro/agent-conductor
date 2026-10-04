export interface SharedDraft { text: string; revision: number }
export interface DraftDestination { ready: boolean; agent: 'claude' | 'codex' | null; token: string; reason?: string }
export class HandoffDrafts {
  constructor(adapter: { destination(id: string): Promise<DraftDestination>; write(id: string, destination: string, text: string, submit: boolean): void });
  get(id: string): SharedDraft;
  set(id: string, text: string): SharedDraft;
  busy(id: string): boolean;
  submit(id: string, revision: number, destination: string, submit?: boolean): Promise<{ ok: boolean; error?: string; draft?: SharedDraft }>;
  clear(): void;
  close(id: string): void;
}
