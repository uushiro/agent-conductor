#!/bin/bash
# Monitor script: local dist/ 更新を検知してClaudeに通知
# Usage: claude --monitor "bash scripts/monitor-local-build.sh"
#
# fswatch (brew install fswatch) でdist/の変更を検知。
# ビルド完了 or エラーをClaudeに知らせる。

DIST_DIR="$(dirname "$0")/../dist"
DIST_ELECTRON_DIR="$(dirname "$0")/../dist-electron"

echo "[Monitor] Watching $DIST_DIR and $DIST_ELECTRON_DIR for build changes..."

fswatch -o "$DIST_DIR" "$DIST_ELECTRON_DIR" 2>/dev/null | while read -r _count; do
  TIMESTAMP=$(date '+%H:%M:%S')
  # dist-electron/main.js の存在で成否を簡易判定
  if [ -f "$DIST_ELECTRON_DIR/main.js" ]; then
    echo "[BUILD UPDATED $TIMESTAMP] dist/ refreshed — build appears successful"
  else
    echo "[BUILD UPDATED $TIMESTAMP] dist/ changed but dist-electron/main.js missing — may have errored"
  fi
done
