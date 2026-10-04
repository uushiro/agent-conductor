export type SwitchAgent = 'claude' | 'codex';

export interface SwitchSession {
  agent: SwitchAgent | null;
  cwd: string;
  ready: boolean;
  reason: string;
  text: string;
  lastEventAt: number;
  lastAssistantText: string;
  errorCode?: string;
}

export interface SwitchMetric {
  from: SwitchAgent | null;
  to: SwitchAgent;
  mode: 'new' | 'reuse';
  outcome: 'success' | 'cancelled' | 'failed';
  errorCode: string | null;
  startedAt: number;
  durations: { readMs: number; startMs: number; waitMs: number; activateMs: number; totalMs: number; rendererMs?: number };
}

export interface AgentSwitchAdapter {
  read(id: string): Promise<SwitchSession>;
  token(): string;
  prompt(source: SwitchSession, token: string): string;
  create(agent: SwitchAgent, cwd: string, prompt: string, token: string): string | Promise<string>;
  send(id: string, prompt: string): Promise<void>;
  activate(logicalId: string, runtimeId: string): void;
  exited(id: string): boolean;
  release(id: string): void;
  preflight?(agent: SwitchAgent, cwd: string): Promise<void>;
  status?(id: string): { started: boolean; errorCode?: string; reason?: string } | Promise<{ started: boolean; errorCode?: string; reason?: string }>;
  recordMetric?(metric: SwitchMetric, logicalId: string): void;
}

export interface AgentSwitchState {
  agent: SwitchAgent | null;
  phase: 'preparing' | 'error' | 'idle';
  target: SwitchAgent | null;
  canSwitch: boolean;
  reason: string;
  history: Array<{ agent: SwitchAgent; text: string }>;
  progress: { stage: 'reading' | 'starting' | 'waiting'; startedAt: number; stageStartedAt: number; elapsedMs: number } | null;
  errorCode: string | null;
  recovery: { agent: SwitchAgent; exited: boolean } | null;
  lastAttempt: SwitchMetric | null;
}

export interface AgentSwitchGroup {
  active: string;
  members: Set<string>;
  history: Array<{ agent: SwitchAgent; text: string }>;
  pending: unknown;
  error: string;
  errorCode: string | null;
  recovery: unknown;
  lastAttempt: SwitchMetric | null;
  progress: AgentSwitchState['progress'];
}

export class AgentSwitchController {
  groups: Map<string, AgentSwitchGroup>;
  constructor(adapter: AgentSwitchAdapter, options?: { timeoutMs?: number; pollMs?: number });
  active(id: string): string;
  owner(runtime: string): string;
  blocked(runtime: string): boolean;
  state(id: string): Promise<AgentSwitchState>;
  switch(id: string, target: SwitchAgent): Promise<{ ok: boolean; error?: string; errorCode?: string }>;
  metrics(): SwitchMetric[];
  recoveryRuntime(id: string): string | null;
  cancel(id: string): void;
  close(id: string): void;
  clear(): void;
}
