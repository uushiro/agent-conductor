import test from 'node:test'
import assert from 'node:assert/strict'
import { codexMetaFromSessionRecord, resolveCodexSessionLineage } from './codex-session-lineage.mjs'

const guardian = '018f0001-1111-7111-8111-111111111111'
const parent = '018f0000-2222-7222-8222-222222222222'
const cwd = '/work/project'
const meta = (id, source, parentThreadId = null, extra = {}) => ({ id, fileId: id, cwd, source, originator: 'codex_chatgpt_desktop', parentThreadId, ...extra })

test('guardian UUIDv7 migrates only to a verified same-cwd interactive parent', () => {
  const parentRecord = { type: 'session_meta', payload: { id: parent, cwd, source: 'vscode', originator: 'codex-tui' } }
  const guardianRecord = { type: 'session_meta', payload: { id: guardian, parent_thread_id: parent, cwd, source: { subagent: { other: 'guardian' } }, originator: 'codex-tui' } }
  const result = resolveCodexSessionLineage(guardian, cwd, [codexMetaFromSessionRecord(guardianRecord, guardian), codexMetaFromSessionRecord(parentRecord, parent)])
  assert.deepEqual(result, { ok: true, id: parent, migrated: true, depth: 1 })
})

test('guardian migration fails closed for missing, mismatched, and forged parents', () => {
  assert.equal(resolveCodexSessionLineage(guardian, cwd, [meta(guardian, { subagent: { other: 'guardian' } }, parent)]).code, 'parent_missing')
  assert.equal(resolveCodexSessionLineage(guardian, cwd, [meta(guardian, { subagent: { other: 'guardian' } }, parent), meta(parent, 'vscode', null, { cwd: '/other' })]).code, 'cwd_mismatch')
  assert.equal(resolveCodexSessionLineage(guardian, cwd, [meta(guardian, { subagent: { other: 'guardian' } }, parent), meta(parent, 'vscode', null, { fileId: guardian })]).code, 'parent_missing')
  assert.equal(resolveCodexSessionLineage(guardian, cwd, [meta(guardian, { unknown: true }, parent), meta(parent, 'vscode')]).code, 'not_interactive')
})

test('lineage traversal is cycle-safe and depth-bounded', () => {
  const a = guardian, b = parent
  assert.equal(resolveCodexSessionLineage(a, cwd, [meta(a, { subagent: true }, b), meta(b, { subagent: true }, a)]).code, 'lineage_cycle')
  assert.equal(resolveCodexSessionLineage(a, cwd, [meta(a, { subagent: true }, b), meta(b, { subagent: true }, '018f0000-3333-7333-8333-333333333333')], 1).code, 'lineage_too_deep')
})
