import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readClaudeSessionTitle } from './claude-session-title.mjs'

function withSession(records, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-conductor-title-'))
  const filePath = path.join(dir, 'session.jsonl')
  try {
    fs.writeFileSync(filePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
    run(filePath)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('prefers Claude ai-title over the raw user prompt', () => {
  withSession([
    { type: 'system', parentUuid: null },
    { type: 'user', parentUuid: 'system-id', origin: { kind: 'human' }, message: { content: '復号して\n/path/to/file.csv' } },
    { type: 'ai-title', aiTitle: '送金一覧CSVの復号' },
  ], (filePath) => assert.equal(readClaudeSessionTitle(filePath), '送金一覧CSVの復号'))
})

test('finds ai-title in the tail after a very large record', () => {
  withSession([
    { type: 'user', parentUuid: null, message: { content: 'x'.repeat(100_000) } },
    { type: 'assistant', message: { content: 'y'.repeat(100_000) } },
    { type: 'ai-title', aiTitle: '大きなセッションのタイトル' },
  ], (filePath) => assert.equal(readClaudeSessionTitle(filePath), '大きなセッションのタイトル'))
})

test('uses a modern human prompt even when it has a parent UUID', () => {
  withSession([
    { type: 'system', parentUuid: null },
    { type: 'user', parentUuid: 'system-id', origin: { kind: 'human' }, message: { content: 'スプレッドシートを確認して' } },
    { type: 'user', parentUuid: 'tool-id', message: { content: [{ type: 'tool_result', content: 'ignored' }] } },
  ], (filePath) => assert.equal(readClaudeSessionTitle(filePath), 'スプレッドシートを確認して'))
})

test('keeps compatibility with legacy root user records', () => {
  withSession([
    { type: 'user', parentUuid: null, message: { content: [{ type: 'text', text: '古いClaudeセッション\n詳細' }] } },
  ], (filePath) => assert.equal(readClaudeSessionTitle(filePath), '古いClaudeセッション'))
})

test('uses text-bearing user records from transitional Claude versions', () => {
  withSession([
    { type: 'system', parentUuid: null },
    { type: 'user', parentUuid: 'system-id', message: { content: '中間形式のClaudeセッション' } },
    { type: 'user', parentUuid: 'tool-id', message: { content: [{ type: 'tool_result', content: 'ignored' }] } },
  ], (filePath) => assert.equal(readClaudeSessionTitle(filePath), '中間形式のClaudeセッション'))
})

test('ignores tool results and malformed bounded-read fragments', () => {
  withSession([
    { type: 'system', parentUuid: null, content: 'z'.repeat(70_000) },
    { type: 'user', parentUuid: 'tool-id', message: { content: [{ type: 'tool_result', content: 'ignored' }] } },
  ], (filePath) => assert.equal(readClaudeSessionTitle(filePath), null))
})
