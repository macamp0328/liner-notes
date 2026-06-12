#!/usr/bin/env sh
# prepare-time git-hook installer (issue #295).
#
# husky wires the local pre-commit/pre-push walls the repo's safety model leans
# on (branch guards, the coverage gate). The old `husky || true` swallowed every
# failure unconditionally, so a clone where husky genuinely failed to install
# ended up with no walls and no signal. We instead skip cleanly where hooks
# can't or shouldn't be installed, and otherwise fail loudly.
#
# Note husky v9 NEVER exits non-zero: it prints a diagnostic and returns 0 even
# when `git config core.hooksPath` fails, and is completely silent on success.
# So a clean exit code is not proof the hooks installed — after the skip guards
# below, any husky output means a real failure, which we surface and turn into a
# non-zero exit.

# No git checkout (Docker image build, npm-pack tarball): nothing to hook.
# `-e` not `-d`: in a git worktree `.git` is a file, and it mirrors husky's own
# `existsSync('.git')` check.
[ -e .git ] || exit 0
# CI runners never commit or push, so the walls are pointless noise there.
[ -n "${CI:-}" ] && exit 0
# husky's standard opt-out.
[ "${HUSKY:-}" = "0" ] && exit 0

output=$(husky 2>&1)
status=$?
if [ "$status" -ne 0 ] || [ -n "$output" ]; then
  [ -n "$output" ] && printf '%s\n' "$output" >&2
  echo "prepare: husky did not install the git hooks — pre-commit/pre-push walls are NOT active (issue #295). Fix the error above, re-run 'pnpm install', or set HUSKY=0 to skip." >&2
  exit 1
fi
exit 0
