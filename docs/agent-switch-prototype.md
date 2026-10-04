# Agent switch prototype: manual UX checklist

This prototype hands a visible terminal tab between Claude and Codex. The logical
tab ID stays the same. Run this checklist manually before relying on the feature.

## Handoff behavior

- [x] In a Claude tab, switch to Codex and verify the tab remains in the same
  position with the latest useful context available.
- [x] Switch the same tab back from Codex to Claude and verify the same result.
- [ ] Confirm that no agent input is accepted while a handoff is preparing.
- [ ] Confirm a handoff cannot start while the CLI is busy or otherwise reports
  a disabled reason.
- [x] Confirm the displayed agent and the available target update after the
  backend acknowledgement.

## Failure and cancellation

- [x] Start a handoff and cancel it before readiness; verify the original CLI
  remains usable and the progress state clears.
- [x] Exercise a readiness timeout and verify an understandable inline error
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
  A timeout retains the target; “切り替え先を確認” opens a separate terminal for
  manual login/trust interaction. Retrying reuses that target after its conversation
  is ready. The source remains available throughout failure recovery.
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
  Failure retains at most one recovery target rather than silently discarding its
  setup/error screen. Recovery input is rejected during a pending retry.
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


## Native verification, 2026-10-04

Test setup: isolated Electron Preview profile and synthetic workspace, using real
Claude Code 2.1.289 and Codex 0.160.0 processes and model responses. The installed
application was not replaced. The Preview wrapper suppressed the unrelated Resume
session list; handoff IPC, PTYs, transcripts and model responses were not mocked.

Issues discovered and corrected during this run:

- Codex's UUIDv7 session IDs were rejected by the transcript reader, causing a
  timeout despite a completed acknowledgement. Synthetic tests now use UUIDv7.
- Claude hooks can append explanatory text to a completed acknowledgement. The
  controller now requires the unpredictable nonce on a standalone line in the
  final completed assistant response; a user echo or inline quoted token cannot
  complete the switch.
- Session discovery is rearmed before a delayed first prompt if its startup
  watcher has expired. The IPC test covers expiry and rearming.
- Same-tab activation explicitly resizes the new PTY to the existing pane.
- Ctrl+U and batched Backspace now clear tracked end-of-line drafts correctly.
  Cursor/history/completion operations that cannot be reconstructed keep switching
  disabled until submission or Ctrl+C; the UI explains this recovery path.
- Error/cancellation messages no longer freeze readiness polling, which could
  otherwise leave the retry button disabled after the backend had recovered.

Final corrected-build observations:

- Claude → Codex reached idle/ready by the 8.1-second observation; Codex received
  the synthetic facts (灯台 / 金曜 / 3500円 / 藍) and updated delivery to 土曜 and
  color to 白.
- Codex → the original Claude session reached idle/ready by the 15.1-second
  observation. These are polling upper bounds from one run, not latency percentiles.
- After returning, a fresh question supplied only the four field names (no
  answer hints). Claude answered 灯台 / 土曜 / 3500円 / 白; verified in the real
  completed assistant transcript. Post-handoff input and latest context work.
- An actual toolbar cancellation after more than one second of preparation
  restored the enabled submit button. During preparation, submit was disabled,
  Cancel was visible, and the terminal exposed aria-busy=true.
- After the final input-tracking patch, the restarted native Preview disabled
  handoff for an unsent draft and restored it after both Ctrl+U and six Backspaces.
- The earlier failed runs retained the source and surfaced the timeout error.

This removes manual tab creation and copying context, but it is not an instant
model toggle. A target model turn still takes seconds; terminal scrollback can
show the handoff prompt/nonce and CLI hook explanations. Authentication failures,
first-run dialogs, split-pane focus, and long/repeated handoff quality still need
native checks before promoting the feature from experimental use.


## P0: observable progress and recovery

The toolbar reports reading, starting and waiting based on controller operations,
observed native process/transcript startup and the completed receipt. Elapsed time
is shown alongside cancellation, without a guessed percentage or ETA. Completed
handoffs name the active agent. Current draft/busy reasons take precedence over
an older success message.

A login-shell executable check distinguishes a missing CLI from a generic launch
check failure before another PTY is created. Known invalid transcript formats,
identity/size failures, target exit and receipt timeout have separate error codes.
A timeout does not assert that authentication is the cause. The retained target's
actual terminal can be opened to inspect and interact with its setup/error state.
Closing this dialog returns to the source; retry sends the latest source context
with a fresh nonce into the same ready target. No setup acceptance is automated.

The last 100 attempts are kept in `handoff-metrics.json` in the app's user-data
directory. Fields are only agents, new/reuse mode, outcome/error code, start time
and durations; no prompts, transcript text, session IDs or working paths are
recorded. Measurements include read, startup, receipt wait, activation dispatch,
and a separately acknowledged `rendererMs`. That final measurement ends after
xterm output/geometry/focus have been applied AND input is enabled. It is absent
until acknowledged; switching away from the pane can extend it by user wait time.
Stage times are observed boundaries (backend polling), not provider-side latency.

Automated coverage includes missing CLI without spawn, retained-target recovery,
retries without duplicate PTYs, recovery-input rejection during retry, stale
render-token rejection, cancellation races, and content-free persisted metrics.
Native measurements (2026-10-04, synthetic conversation, actual toolbar actions):

| Direction | Samples | Mode | Success / failure | Total p50 / p95 | Renderer p50 / p95 |
| --- | ---: | --- | --- | --- | --- |
| Claude → Codex | 10 | 1 new, 9 reuse | 10 / 0 | 5.232s / 10.790s | 15ms / 42ms |
| Codex → Claude | 10 | 10 reuse | 10 / 0 | 6.763s / 10.844s | 13ms / 21ms |

Percentiles use empirical nearest rank; these small samples are not a production
latency guarantee. Eight earlier attempts exposed a single-pane focus bug and
were excluded. The fixed build restores focus and measured input-ready rendering
in every sample (7–42ms). There is no fresh-Claude sample in this benchmark.
An intentional cancellation after 1.2s is recorded separately: the source remained
active, input was re-enabled and the terminal textarea regained focus. A subsequent
no-hint recall still returned the latest four synthetic conditions correctly.

The source of most elapsed time is receipt waiting, not UI activation. Skipping
the receipt check solely to appear faster would weaken the handoff guarantee;
next work should reduce repeated context and improve what the user sees while
waiting. The initial native focus issue was fixed in the single-pane focus prop,
not by reporting a fabricated zero renderer duration.


A separate native Electron + node-pty fixture exercised a simulated first-run gate:
receipt timeout kept the source and target alive; the user opened the recovery
terminal, entered `confirm`, and retried successfully in reuse mode (514ms).
The model/CLI/preflight and transcript home were fixture-controlled. This validates
the modal and recovery wiring, not real authentication or account setup. Real
login failure/first-run provider dialogs and split-pane visual QA remain open.
Recovery drafts are tracked too: retry cannot overwrite an unsent setup input,
and terminal control replies do not invalidate a completed receipt.
