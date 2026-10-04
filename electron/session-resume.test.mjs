import test from 'node:test'
import assert from 'node:assert/strict'
import { consumeOsc7, exactClaudeSessionId, mergeRestoreSnapshot, savedResumeCommand, selectedIndex } from './session-resume.mjs'

const one = '11111111-1111-4111-8111-111111111111'
const two = '22222222-2222-4222-8222-222222222222'

test('exact identity helpers never substitute a same-cwd latest session', () => {
  assert.equal(exactClaudeSessionId({ claudeResumeParentId: one, claudeSessionId: two }), one)
  assert.equal(exactClaudeSessionId({ claudeSessionId: 'not-an-id' }), null)
  assert.deepEqual(savedResumeCommand({ hadClaude: true, cwd: '/project', claudeSessionId: null }, '/home'), {
    ok: false, reason: '保存されたClaudeの会話IDがありません。'
  })
})

test('restore commands carry only exact saved identities', () => {
  assert.equal(savedResumeCommand({ hadClaude: true, claudeSessionId: one, launchModel: 'sonnet' }, '/home').command, `claude --model sonnet --resume ${one}\r`)
  assert.equal(savedResumeCommand({ hadCodex: true, codexSessionId: two }, '/home').command, `codex resume ${two}\r`)
  const gemini = savedResumeCommand({ hadGemini: true, cwd: '/work/project', geminiSessionFile: '/home/.gemini/tmp/project/chats/session-abc_123.json' }, '/home')
  assert.equal(gemini.command, "gemini --session-file '/home/.gemini/tmp/project/chats/session-abc_123.json'\r")
})

test('all tabs and selected index survive restore-in-progress saves', () => {
  const original = { tabs: Array.from({ length: 16 }, (_, i) => ({ issue: `saved-${i}` })), activeIndex: 2 }
  const merged = mergeRestoreSnapshot(original, new Map([[0, { issue: 'live-0' }], [1, { issue: 'live-1' }]]), false)
  assert.equal(merged.tabs.length, 16)
  assert.equal(merged.tabs[0].issue, 'live-0')
  assert.equal(merged.tabs[15].issue, 'saved-15')
  assert.equal(selectedIndex(['a', 'b', 'c'], 'c'), 2)
})

test('OSC 7 readiness survives PTY chunk boundaries', () => {
  const first = consumeOsc7('', '\u001b]7;file://host/work')
  assert.deepEqual(first.sequences, [])
  const second = consumeOsc7(first.tail, '/project\u0007prompt')
  assert.deepEqual(second.sequences, ['\u001b]7;file://host/work/project\u0007'])
  assert.equal(second.tail, 'prompt')
})
