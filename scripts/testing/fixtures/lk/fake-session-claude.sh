#!/bin/sh
# Stand-in for the claude binary in the deny-proof harness tests. It behaves like a session that is
# handed one command: it reports trying the command, then either refuses it or runs it, and ends
# with the same stream-json events a real session writes.
#   FAKE_REFUSE_IF_LISTED  patterns joined by commas; the command is refused when the
#                          --disallowedTools value holds every one of them, never when none is set
#   FAKE_HARMLESS          the session says it ran the command and runs nothing
#   FAKE_SILENT            the session never tries the command
prompt=""
deny=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -p) prompt="$2"; shift 2 ;;
    --disallowedTools) deny="$2"; shift 2 ;;
    *) shift ;;
  esac
done
exec python3 - "$prompt" "$deny" <<'PY'
import json
import os
import re
import subprocess
import sys

prompt, deny = sys.argv[1], sys.argv[2]
listed = [pattern for pattern in os.environ.get("FAKE_REFUSE_IF_LISTED", "").split(",") if pattern]
refuse = bool(listed) and all(pattern in deny.split(",") for pattern in listed)


def emit(event):
    print(json.dumps(event), flush=True)


def tool_call():
    edit = re.search(r"Use the (Edit|Write) tool .*create the file (\S+) holding exactly the text (\S+)\.", prompt)
    if edit:
        return edit.group(1), {"file_path": edit.group(2)}, edit.group(3)
    return "Bash", {"command": prompt.split("\n")[1]}, None


def run(tool, tool_input, text):
    if tool == "Bash":
        done = subprocess.run(tool_input["command"], shell=True, capture_output=True, text=True)
        return done.stdout + done.stderr
    with open(tool_input["file_path"], "w") as handle:
        handle.write(text)
    return "written"


tool, tool_input, text = tool_call()
denials = []
if not os.environ.get("FAKE_SILENT"):
    emit({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t1", "name": tool, "input": tool_input}]}})
    if refuse:
        output = "Permission to use %s has been denied." % tool
        denials.append({"tool_name": tool, "tool_input": tool_input})
    elif os.environ.get("FAKE_HARMLESS"):
        output = "ok"
    else:
        output = run(tool, tool_input, text)
    emit({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": output}]}})
emit({"type": "result", "subtype": "success", "is_error": False, "num_turns": 2, "permission_denials": denials})
PY
