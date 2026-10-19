#!/bin/sh
# Stand-in for the claude binary in the scripts/lk tests. It records every call to the file named
# by FAKE_CLAUDE_LOG, NUL separated so a prompt with newlines survives, then answers by mode:
# FAKE_SMOKE picks the smoke answer (ok, silent, fail, okfail), FAKE_MAIN_EXIT the session exit code
# and FAKE_RELEASE_FILE holds the session open until that file exists.
log="${FAKE_CLAUDE_LOG:?}"
smoke=""
{
  printf 'CALL\0'
  for arg in "$@"; do
    printf 'ARG %s\0' "$arg"
    if [ "$arg" = "--max-turns" ]; then smoke=1; fi
  done
  printf 'ENV LK_ROLE=%s LK_SLUG=%s\0' "$LK_ROLE" "$LK_SLUG"
} >> "$log"

if [ -n "$smoke" ]; then
  case "$FAKE_SMOKE" in
    silent) echo "no idea"; exit 0 ;;
    okfail) echo "Nicholas, ok"; exit 1 ;;
    fail) echo "model not found" >&2; exit 1 ;;
    *) echo "Nicholas, OK"; exit 0 ;;
  esac
fi

cp ".work/$LK_SLUG/run.json" "${FAKE_RUN_SNAPSHOT:?}"
if [ -e .work/.lock ]; then echo present > "${FAKE_RUN_SNAPSHOT}.lock"; fi
if [ -n "$FAKE_RELEASE_FILE" ]; then
  while [ ! -e "$FAKE_RELEASE_FILE" ]; do sleep 0.1; done
fi
echo '{"type":"result"}'
exit "${FAKE_MAIN_EXIT:-0}"
