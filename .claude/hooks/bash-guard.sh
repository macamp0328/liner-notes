#!/bin/sh
# PreToolUse guard for the Bash tool (wall 2: agents cannot bypass the git walls).
#
# Blocks:
#   - --no-verify on git commit/push — skipping the husky hooks (prettier, lint,
#     typecheck, coverage, branch guards) defeats every local wall at once.
#   - plain `git push --force` / `-f` — rewrites remote history; --force-with-lease
#     stays allowed for the rare legitimate rebase.
#
# Exit 2 blocks the tool call; stderr is shown to the agent so it can self-correct.
# Deliberately dependency-free (POSIX sh + absolute /usr/bin tools only): worktrees
# with an untrusted .mise.toml get a clobbered PATH in subshells, so nothing here
# may rely on jq/node/mise shims.
#
# Matching is LINE-wise: the offending flag must appear on the same line as the
# `git commit` / `git push` invocation. This keeps commit-message bodies (heredocs,
# -m text on other lines) that merely *mention* the flags from tripping the guard.
# The `git[^|;&]*(commit|push)` shape tolerates global options BETWEEN `git` and the
# subcommand (e.g. `git -c core.hooksPath=/dev/null commit --no-verify`, `git -C path
# push --force`) so they can't slip past, while the `[^|;&]` class still stops a
# `;`/`|`/`&&`-chained later command from being glued onto the `git` invocation.
# Known limitation (unchanged from the adjacency form): a flag mentioned on the SAME
# physical line as a real `git commit`/`git push` — e.g. `git commit -m "... --no-verify ..."`
# — still trips the guard. Use a heredoc / separate-line message body to avoid it.

input="$(cat 2>/dev/null)"
# Older settings exposed the tool input via env var; accept either.
[ -n "${CLAUDE_TOOL_INPUT:-}" ] && input="$input ${CLAUDE_TOOL_INPUT}"

case "$input" in
  *git*commit* | *git*push*) ;;
  *) exit 0 ;;
esac

# The tool input arrives as JSON, so multi-line commands are one physical line with
# \n escapes — expand them back to real newlines so the per-line checks work, then
# re-join backslash-continued lines so a flag split across a continuation ends up on
# the same logical line as its git invocation.
normalized="$(printf '%s' "$input" \
  | /usr/bin/awk '{gsub(/\\n/, "\n"); print}' \
  | /usr/bin/awk '/\\+$/ { sub(/\\+$/, " "); printf "%s", $0; next } { print }')"

if printf '%s\n' "$normalized" | /usr/bin/grep -E 'git[^|;&]*(commit|push)' | /usr/bin/grep -q -- '--no-verify'; then
  echo "Blocked: --no-verify skips the husky hooks (prettier/lint/typecheck/coverage/branch guards). Fix the underlying failure instead of bypassing it." >&2
  exit 2
fi

# `--force-with-lease` is allowed: the ([ \"';]|$) tail keeps plain --force from
# matching it, and ` -f` needs leading whitespace so e.g. `-f`ile args don't trip it.
if printf '%s\n' "$normalized" | /usr/bin/grep -Eq -- 'git[^|;&]*push[^|;&]*( -f([ "'\'']|$)|--force([ "'\'']|$))'; then
  echo "Blocked: plain force-push rewrites remote history. If a rewrite is genuinely needed, use git push --force-with-lease." >&2
  exit 2
fi

exit 0
