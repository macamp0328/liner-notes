#!/usr/bin/env bash
# Detect the ::add-mask:: multi-line JSON anti-pattern in GitHub Actions workflows.
#
# WHAT THIS CATCHES
# -----------------
# ::add-mask:: only masks the value on the same physical line as the command.
# When a variable holds a multi-line JSON blob (e.g. from `aws secretsmanager
# get-secret-value`), masking it whole (`echo "::add-mask::$var"`, or the
# equivalent `printf '::add-mask::%s' "$var"`) masks only the opening `{` and
# logs every remaining line — including all secret values — to the public build
# log as plaintext.
#
# This script flags any workflow file where a variable is:
#   1. assigned from `aws … secretsmanager get-secret-value` (any global flags
#      between `aws` and the subcommand are tolerated), AND
#   2. referenced on a line that also contains `::add-mask::` — i.e. the whole
#      blob is being masked at once, instead of each field being extracted with
#      jq and masked individually.
#
# CORRECT PATTERN
# ---------------
#   json="$(aws secretsmanager get-secret-value ...)"
#   for k in KEY1 KEY2; do
#     v="$(printf '%s' "$json" | jq -r --arg k "$k" '.[$k]')"
#     echo "::add-mask::$v"    # <-- mask each single-line value individually
#     echo "$k=$v" >> "$GITHUB_ENV"
#   done
#
# WRONG PATTERN (what this script catches)
# -----------------------------------------
#   json="$(aws secretsmanager get-secret-value ...)"
#   echo "::add-mask::$json"  # <-- masks only '{', leaks the rest
#
# SCOPE / KNOWN LIMITS
# --------------------
# Scans both *.yml and *.yaml at the top level of the workflows dir. It does NOT
# scan composite-action `action.yml` files in subdirectories (none here fetch
# secrets) — pass their dir explicitly if that changes. Detection is a textual
# heuristic, not a shell parser: it catches the honest `echo`/`printf` mistake,
# not a determined obfuscation (e.g. aliasing the blob to a second variable
# first). Word-boundary matching keeps a blob var `json` from flagging a SAFE
# `echo "::add-mask::$jsonValue"` (a jq-extracted scalar).
#
# Usage: bash scripts/check-mask.sh [workflows-dir]
# Exit:  0 = clean, 1 = violations found

set -euo pipefail

WORKFLOWS_DIR="${1:-.github/workflows}"
fail=0

for f in "$WORKFLOWS_DIR"/*.yml "$WORKFLOWS_DIR"/*.yaml; do
  # A non-matching glob stays literal (no nullglob); skip it. Also skips a real
  # path that isn't a regular file.
  [ -f "$f" ] || continue

  # Collect variable names assigned from `aws … secretsmanager get-secret-value`.
  # Tolerates global flags between `aws` and the subcommand (e.g.
  # `aws --region us-east-1 secretsmanager …`) and a space after `$(`, and both
  # the quoted and unquoted command-substitution forms:
  #   var="$(aws secretsmanager get-secret-value …)"
  #   var=$( aws --profile p secretsmanager get-secret-value …)
  secretvars="$(
    grep -oE '[a-zA-Z_][a-zA-Z0-9_]*="?\$\([[:space:]]*aws[[:space:]].*secretsmanager[[:space:]]+get-secret-value' "$f" 2>/dev/null \
    | grep -oE '^[a-zA-Z_][a-zA-Z0-9_]*' \
    || true
  )"

  [ -z "$secretvars" ] && continue

  # Lines that invoke ::add-mask::, excluding shell-comment lines (a comment that
  # merely documents the anti-pattern must not trip the guard). Computed once per
  # file, reused for every blob var.
  maskcmds="$(grep -E '::add-mask::' "$f" 2>/dev/null | grep -vE '^[[:space:]]*#' || true)"
  [ -z "$maskcmds" ] && continue

  while IFS= read -r varname; do
    [ -z "$varname" ] && continue

    # Does a ::add-mask:: line reference this blob var as a WHOLE value? Match
    # `$var` (followed by a non-identifier char or end-of-line, so `$json` does
    # not match `$jsonValue`) or the braced `${var}` form. Catches both
    # `echo "::add-mask::$var"` and `printf '::add-mask::%s' "$var"`.
    if printf '%s\n' "$maskcmds" \
       | grep -qE "(\\\$${varname}([^a-zA-Z0-9_]|\$)|\\\$\\{${varname}\\})"; then
      echo "::error file=$f::'\$$varname' (a Secrets Manager JSON blob) is passed whole to ::add-mask::. ::add-mask:: is single-line only — the blob leaks every line after the first to the public log. Extract each field with jq and mask each value individually." >&2
      fail=1
    fi
  done <<VARNAMES
$secretvars
VARNAMES
done

if [ "$fail" -eq 0 ]; then
  echo "check-mask.sh: no ::add-mask:: secret blob anti-patterns found."
fi

exit "$fail"
