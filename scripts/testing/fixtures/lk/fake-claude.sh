#!/bin/sh
# Stand-in for the claude binary in the scripts/lk tests. It records every call to the file named
# by FAKE_CLAUDE_LOG, NUL separated so a prompt with newlines survives, then answers by mode:
# FAKE_SMOKE picks the smoke answer (ok, silent, fail, okfail, broken, hang, or text to print
# FAKE_SMOKE_TEXT), FAKE_MAIN_EXIT the session exit code, FAKE_RELEASE_FILE holds the session open
# until that file exists (at most 30 seconds) and FAKE_SIGNAL_FILE makes the session note each INT,
# TERM or HUP it receives and then die of that same signal. The session writes
# "$FAKE_RUN_SNAPSHOT.ready" once it is waiting.
log="${FAKE_CLAUDE_LOG:?}"
smoke=""
{
  printf 'CALL\0'
  for arg in "$@"; do
    printf 'ARG %s\0' "$arg"
    if [ "$arg" = "--max-turns" ]; then smoke=1; fi
  done
  printf 'ENV LK_ROLE=%s LK_SLUG=%s LK_GOVERNANCE_GRANT=%s\0' "$LK_ROLE" "$LK_SLUG" "$LK_GOVERNANCE_GRANT"
  printf 'CWD %s\0' "$(pwd -P)"
} >> "$log"

if [ -n "$smoke" ]; then
  case "$FAKE_SMOKE" in
    silent) echo "no idea"; exit 0 ;;
    okfail) echo "Nicholas, ok"; exit 1 ;;
    fail) echo "model not found" >&2; exit 1 ;;
    text) echo "$FAKE_SMOKE_TEXT"; exit 0 ;;
    broken) echo "the model is broken"; exit 0 ;;
    hang) exec sleep 30 ;;
    *) echo "Nicholas, OK"; exit 0 ;;
  esac
fi

if [ -n "$FAKE_SIGNAL_FILE" ]; then
  trap 'echo SIGINT >> "$FAKE_SIGNAL_FILE"; trap - INT; kill -INT $$' INT
  trap 'echo SIGTERM >> "$FAKE_SIGNAL_FILE"; trap - TERM; kill -TERM $$' TERM
  trap 'echo SIGHUP >> "$FAKE_SIGNAL_FILE"; trap - HUP; kill -HUP $$' HUP
fi

cp ".work/$LK_SLUG/run.json" "${FAKE_RUN_SNAPSHOT:?}"
if [ -e .work/.lock ]; then echo present > "${FAKE_RUN_SNAPSHOT}.lock"; fi
echo "stderr from the session" >&2
: > "${FAKE_RUN_SNAPSHOT}.ready"
if [ -n "$FAKE_RELEASE_FILE" ]; then
  waited=0
  while [ ! -e "$FAKE_RELEASE_FILE" ] && [ "$waited" -lt 300 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
fi
echo '{"type":"result"}'
exit "${FAKE_MAIN_EXIT:-0}"
