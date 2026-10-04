export type SwitchAgent = 'claude' | 'codex';

export interface SwitchSession {
  agent: SwitchAgent | null;
  cwd: string;
  ready: boolean;
  reason: string;
  text: string;
  lastEventAt: number;
  lastAssistantText: string;
}

export interface AgentSwitchAdapter {
  read(id: string): Promise<SwitchSession>;
  token(): string;
  prompt(source: SwitchSession, token: string): string;
  create(agent: SwitchAgent, cwd: string, prompt: string, token: string): string;
  send(id: string, prompt: string): Promise<void>;
  activate(logicalId: string, runtimeId: string): void;
  exited(id: string): boolean;
  release(id: string): void;
}

export interface AgentSwitchState {
  agent: SwitchAgent | null;
  phase: 'preparing' | 'error' | 'idle';
  target: SwitchAgent | null;
  canSwitch: boolean;
  reason: string;
  history: Array<{ agent: SwitchAgent; text: string }>;
}

export interface AgentSwitchGroup {
  active: string;
  members: Set<string>;
  history: Array<{ agent: SwitchAgent; text: string }>;
  pending: unknown;
  error: string;
}

export class AgentSwitchController {
  groups: Map<string, AgentSwitchGroup>;
  constructor(adapter: AgentSwitchAdapter, options?: { timeoutMs?: number; pollMs?: number });
  active(id: string): string;
  owner(runtime: string): string;
  blocked(runtime: string): boolean;
  state(id: string): Promise<AgentSwitchState>;
  switch(id: string, target: SwitchAgent): Promise<{ ok: boolean; error?: string }>;
  cancel(id: string): void;
  close(id: string): void;
  clear(): void;
}
