#!/bin/bash
# Monitor script for Claude Code's Monitor feature
# Usage: claude --monitor "bash scripts/monitor-ci.sh"
#
# Watches uushiro/agent-conductor GitHub Actions runs.
# Outputs a line ONLY when run status changes → Claude wakes up only then.

REPO="uushiro/agent-conductor"
LAST_STATE=""

while true; do
  CURRENT=$(gh run list \
    --repo "$REPO" \
    --limit 1 \
    --json databaseId,status,conclusion,displayTitle,headBranch \
    --jq '.[0] | "\(.databaseId) \(.status) \(.conclusion // "-") \(.headBranch) \(.displayTitle)"' \
    2>/dev/null) || true

  if [ -n "$CURRENT" ] && [ "$CURRENT" != "$LAST_STATE" ]; then
    LAST_STATE="$CURRENT"
    STATUS=$(echo "$CURRENT" | awk '{print $2}')
    CONCLUSION=$(echo "$CURRENT" | awk '{print $3}')
    BRANCH=$(echo "$CURRENT" | awk '{print $4}')
    TITLE=$(echo "$CURRENT" | cut -d' ' -f5-)

    case "$STATUS" in
      completed)
        case "$CONCLUSION" in
          success)  echo "[CI SUCCESS] $BRANCH: $TITLE" ;;
          failure)  echo "[CI FAILURE] $BRANCH: $TITLE" ;;
          cancelled) echo "[CI CANCELLED] $BRANCH: $TITLE" ;;
          *)        echo "[CI $CONCLUSION] $BRANCH: $TITLE" ;;
        esac
        ;;
      in_progress) echo "[CI RUNNING] $BRANCH: $TITLE" ;;
      queued)      echo "[CI QUEUED] $BRANCH: $TITLE" ;;
    esac
  fi

  sleep 15
done
