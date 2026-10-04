import type { HandoffSession, HandoffTurn } from './agent-handoff.mjs';

export interface HandoffContextStats {
  turnCount: number;
  omittedReceipts: number;
  truncated: boolean;
  droppedTurns: number;
  retainedUnknown: number;
  truncatedTurns?: number;
  added?: number;
  omittedReceiptsThisMerge?: number;
}
export interface HandoffContextSource extends Pick<HandoffSession, 'agent' | 'sessionId' | 'text'> {
  turns?: HandoffTurn[];
}
export class HandoffContext {
  constructor(bounds?: { maxRecords?: number; maxBytes?: number; maxReceipts?: number });
  registerReceipt(source: HandoffContextSource, prompt: string, token: string): { agent: string; sessionId: string; user: { id: string; digest: string }; assistant: { id: string; digest: string } | null } | null;
  merge(source: HandoffContextSource): { text: string; stats: HandoffContextStats };
  serialize(): { text: string; stats: HandoffContextStats };
  exportSnapshot(): unknown;
  static fromSnapshot(snapshot: unknown, bounds?: { maxRecords?: number; maxBytes?: number; maxReceipts?: number }): HandoffContext | null;
}
