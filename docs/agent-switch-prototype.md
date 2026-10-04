# Agent switch prototype: manual UX checklist

This prototype hands a visible terminal tab between Claude and Codex. The logical
tab ID stays the same. Run this checklist manually before relying on the feature.

## Handoff behavior

- [ ] In a Claude tab, switch to Codex and verify the tab remains in the same
  position with the latest useful context available.
- [ ] Switch the same tab back from Codex to Claude and verify the same result.
- [ ] Confirm that no agent input is accepted while a handoff is preparing.
- [ ] Confirm a handoff cannot start while the CLI is busy or otherwise reports
  a disabled reason.
- [ ] Confirm the displayed agent and the available target update after the
  backend acknowledgement.

## Failure and cancellation

- [ ] Start a handoff and cancel it before readiness; verify the original CLI
  remains usable and the progress state clears.
- [ ] Exercise a readiness timeout and verify an understandable inline error
  appears and terminal input is re-enabled.
- [ ] Exercise an authentication failure and verify the same recovery behavior.
- [ ] Verify a rejected switch or cancel IPC request surfaces an inline error.

## Tabs, panes, and restart

- [ ] Start a handoff, select another tab, then return; verify the original tab
  alone shows its in-flight state and other tabs remain usable.
- [ ] In split view, trigger a reset in each pane and verify only the focused,
  visible pane receives terminal focus.
- [ ] Restart the app and restore an active CLI session. Verify normal session
  restore works. Parked in-memory handoff history is intentionally not restored
  in this initial prototype.

## Content and limits

- [ ] Expand “引き継ぎ内容” and verify entries render as plain text, including
  characters that resemble Markdown or HTML.
- [ ] Verify transcript truncation and omitted attachments/tool outputs are
  reflected in the handoff content or backend reason.
- [ ] Confirm no model picker is implied: Claude and Codex use each CLI's
  configured model for a fresh session; returning to a parked session retains
  that session's existing model.

## Initial scope and known limits

- Experimental Claude ↔ Codex handoff only; no within-provider model selector.
- Uses existing CLI authentication and permission settings. Both CLIs must be
  installed, authenticated, and trusted for the working directory before use.
  Interactive first-run prompts in a hidden target cause a recoverable timeout.
- Source readiness requires a matching session transcript, an explicit completed
  turn, no draft input, and no known running worker. Silence alone is insufficient.
  This does not inspect arbitrary background shell jobs or external processes.
- Supports zsh/bash launch wrappers and the supported local JSONL transcript
  layouts. Unknown/paginated layouts, missing IDs, ambiguous ownership, oversized
  transcripts (>8 MiB), and exhausted Codex searches (2,000 files) fail closed.
- Transfers up to 30,000 characters of text (start + recent conversation), with
  explicit truncation/omission markers. It is not a semantic summary; middle
  decisions, images, reasoning and tool result bodies may be absent. Original
  transcript paths are included for later reference. Repeated handoffs may nest
  prior context and need further compaction design.
- An acknowledgement turn uses the target CLI; this can consume model quota.
  CLI startup/context echo may remain visible in terminal scrollback.
- The source is retained until the target acknowledges reception. Cancellation
  discards a newly launched target; an existing parked session is preserved.
- No automatic task continuation, queued busy switching, or drafting during
  handoff yet. Existing terminal input is blocked only during preparation.
- Tab ID, position, name and working directory remain stable. Six recent text
  handoffs can be inspected in memory. Restart restores the active session only;
  earlier sessions remain in each CLI's normal history, not in a rebuilt tab chain.

## Automated validation

`npm test` includes synthetic transcript/parser tests, lifecycle failure tests and
an IPC integration test with mock PTYs (no real shell/LLM/network). The integration
test exercises stable tab identity, A→B→A, title changes, sidebar visibility,
active-session persistence, draft-input rejection and cleanup. Build and Electron
TypeScript checks supplement these tests. They do not establish real-model handoff
quality or latency; the manual checks above remain necessary before release.
