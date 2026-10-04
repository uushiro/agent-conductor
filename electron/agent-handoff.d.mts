export type HandoffAgent = 'claude' | 'codex';

export interface HandoffSession {
  sessionId: string;
  agent: HandoffAgent;
  cwd: string;
  path: string;
  fingerprint: string;
  ready: boolean;
  reason: string;
  text: string;
  lastEventAt: number;
  lastAssistantText: string;
  turns?: HandoffTurn[];
}

export interface HandoffTurn {
  id: string | null;
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}

export interface ReadHandoffSessionOptions {
  agent: HandoffAgent;
  sessionId: string;
  cwd: string;
  home: string;
}

export interface HandoffPromptSource {
  path?: string;
  text?: string;
}

export function readHandoffSession(options: ReadHandoffSessionOptions): Promise<HandoffSession>;
export function buildHandoffPrompt(options: {
  source: HandoffPromptSource;
  previous?: HandoffPromptSource;
  token: string;
}): string;
