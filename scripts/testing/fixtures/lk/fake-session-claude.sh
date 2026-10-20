#!/bin/sh
# Stand-in for the claude binary in the deny-proof harness tests. It behaves like a session that is
# handed one command: it reports trying the command, then refuses it or runs it, and ends with the
# same stream-json events a real session writes. Like Claude Code it also refuses a command that a
# `permissions.deny` entry of ./.claude/settings.json names, or that a Bash PreToolUse hook of that
# file blocks by exiting 2; any other hook exit code lets the command run.
# Each of the three conditions below is a list of terms joined by commas, `+pattern` meaning the
# --disallowedTools value holds the pattern and `-pattern` that it does not; `always` is true and an
# unset variable is false.
#   FAKE_REFUSE_WHEN     the command is refused
#   FAKE_HARMLESS_WHEN   the command is reported as run and nothing is run
#   FAKE_ALSO_RUN_WHEN   a refused command is run all the same
#   FAKE_SILENT          the session never tries the command
#   FAKE_UNREPORTED_WHEN the command is handled without a tool call being reported
#   FAKE_SESSION_LOG     a file that gets one line per call saying whether the deny flag was there
#   FAKE_HOOK_STDOUT_REACHES_MODEL  what a PreToolUse hook that exits 0 printed is added to the
#                        tool result; unset, it is not, as in a real session
#   FAKE_NO_SESSION_END  the SessionEnd hooks of ./.claude/settings.json are not run
#   FAKE_NO_PRE_TOOL_HOOKS  the PreToolUse hooks of ./.claude/settings.json are not run
#   FAKE_AMBIENT_COMMAND a shell command run before the session's own call, as a process of the
#                        machine would run one the session did not ask for
prompt=""
deny=""
deny_flag="false"
while [ "$#" -gt 0 ]; do
  case "$1" in
    -p) prompt="$2"; shift 2 ;;
    --disallowedTools) deny="$2"; deny_flag="true"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$FAKE_SESSION_LOG" ]; then echo "deny_flag=$deny_flag" >> "$FAKE_SESSION_LOG"; fi
exec python3 - "$prompt" "$deny" <<'PY'
import fnmatch
import json
import os
import re
import subprocess
import sys

prompt, deny = sys.argv[1], sys.argv[2]
listed = set(deny.split(",")) if deny else set()


def condition(name):
    spec = os.environ.get(name, "")
    if spec == "always":
        return True
    terms = [term for term in spec.split(",") if term]
    return bool(terms) and all((term[1:] in listed) == (term[0] == "+") for term in terms)


def emit(event):
    print(json.dumps(event), flush=True)


def tool_call():
    edit = re.search(r"Use the (Edit|Write) tool .*create the file (\S+) holding exactly the text (\S+)\.", prompt)
    if edit:
        return edit.group(1), {"file_path": edit.group(2)}, edit.group(3)
    block = re.search(r"\nBEGIN COMMAND\n(.*)\nEND COMMAND\n", prompt, re.S)
    if block:
        return "Bash", {"command": block.group(1)}, None
    return "Bash", {"command": prompt.split("\n")[1]}, None


def project_settings():
    try:
        return json.load(open(".claude/settings.json"))
    except (OSError, ValueError):
        return {}


def settings_refusal(tool, tool_input):
    if tool != "Bash":
        return None
    command = tool_input["command"]
    for entry in project_settings().get("permissions", {}).get("deny", []):
        match = re.fullmatch(r"Bash\((.*)\)", entry)
        if match and (fnmatch.fnmatchcase(command, match.group(1)) or fnmatch.fnmatchcase("rtk " + command, match.group(1))):
            return "Permission to use Bash with command %s has been denied." % command
    return None


def hook_refusal(tool, tool_input):
    if os.environ.get("FAKE_NO_PRE_TOOL_HOOKS"):
        return None
    for group in project_settings().get("hooks", {}).get("PreToolUse", []):
        if not re.fullmatch(group.get("matcher", ""), tool):
            continue
        for hook in group.get("hooks", []):
            payload = json.dumps({"tool_name": tool, "tool_input": tool_input})
            done = subprocess.run(hook["command"], shell=True, input=payload, capture_output=True, text=True)
            if done.returncode == 2:
                return "PreToolUse:%s hook error: [%s]: %s" % (tool, hook["command"], done.stderr)
            if os.environ.get("FAKE_HOOK_STDOUT_REACHES_MODEL"):
                hook_stdout.append(done.stdout)
    return None


def run_session_end_hooks():
    if os.environ.get("FAKE_NO_SESSION_END"):
        return
    for group in project_settings().get("hooks", {}).get("SessionEnd", []):
        for hook in group.get("hooks", []):
            subprocess.run(hook["command"], shell=True, capture_output=True, text=True)


def run(tool, tool_input, text):
    if tool == "Bash":
        done = subprocess.run(tool_input["command"], shell=True, capture_output=True, text=True)
        return done.stdout + done.stderr
    os.makedirs(os.path.dirname(tool_input["file_path"]), exist_ok=True)
    with open(tool_input["file_path"], "w") as handle:
        handle.write(text)
    return "written"


if os.environ.get("FAKE_AMBIENT_COMMAND"):
    subprocess.run(os.environ["FAKE_AMBIENT_COMMAND"], shell=True, capture_output=True, text=True)
hook_stdout = []
tool, tool_input, text = tool_call()
denials = []
if not os.environ.get("FAKE_SILENT"):
    report = not condition("FAKE_UNREPORTED_WHEN")
    if report:
        emit({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t1", "name": tool, "input": tool_input}]}})
    refusal = None
    if condition("FAKE_REFUSE_WHEN"):
        refusal = "Permission to use %s has been denied." % tool
    refusal = refusal or settings_refusal(tool, tool_input) or hook_refusal(tool, tool_input)
    if refusal:
        output = refusal
        denials.append({"tool_name": tool, "tool_input": tool_input})
        if condition("FAKE_ALSO_RUN_WHEN"):
            run(tool, tool_input, text)
    elif condition("FAKE_HARMLESS_WHEN"):
        output = "ok"
    else:
        output = run(tool, tool_input, text)
    if report:
        emit({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "".join(hook_stdout) + output}]}})
emit({"type": "result", "subtype": "success", "is_error": False, "num_turns": 2, "permission_denials": denials})
run_session_end_hooks()
PY
