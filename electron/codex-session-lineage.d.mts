export interface CodexLineageMeta { id: string | null; fileId: string; cwd: string | null; source: unknown; originator: string | null; parentThreadId: string | null }
export function codexMetaFromSessionRecord(record: unknown, fileId: string): CodexLineageMeta;
export function isInteractiveCodexMeta(meta: CodexLineageMeta | null): boolean;
export function isSubagentCodexMeta(meta: CodexLineageMeta | null): boolean;
export function resolveCodexSessionLineage(requestedId: string, cwd: string, metas: CodexLineageMeta[], maxDepth?: number):
  | { ok: true; id: string; migrated: boolean; depth: number }
  | { ok: false; code: string };
