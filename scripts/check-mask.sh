#!/usr/bin/env bash
# Detect the ::add-mask:: multi-line JSON anti-pattern in GitHub Actions workflows.
#
# WHAT THIS CATCHES
# -----------------
# ::add-mask:: only masks the value on the same physical line as the command.
# When a variable holds a multi-line JSON blob (e.g. from `aws secretsmanager
# get-secret-value`), `echo "::add-mask::$var"` masks only the opening `{`
# and logs every remaining line — including all secret values — to the public
# build log as plaintext.
#
# This script flags any workflow file where a variable is:
#   1. assigned to the output of `aws secretsmanager get-secret-value`, AND
#   2. passed directly to ::add-mask:: instead of going through jq first.
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
# Usage: bash scripts/check-mask.sh [workflows-dir]
# Exit:  0 = clean, 1 = violations found

set -euo pipefail

WORKFLOWS_DIR="${1:-.github/workflows}"
fail=0

for f in "$WORKFLOWS_DIR"/*.yml; do
  # shellcheck disable=SC2254  # glob in [ -f ] is intentional
  [ -f "$f" ] || continue

  # Collect variable names assigned from secretsmanager get-secret-value.
  # Handles both quoted and unquoted forms:
  #   var="$(aws secretsmanager get-secret-value ...)"
  #   var=$(aws secretsmanager get-secret-value ...)
  secretvars="$(
    grep -oE '[a-zA-Z_][a-zA-Z0-9_]*="?\$\(aws secretsmanager get-secret-value' "$f" 2>/dev/null \
    | grep -oE '^[a-zA-Z_][a-zA-Z0-9_]*' \
    || true
  )"

  [ -z "$secretvars" ] && continue

  while IFS= read -r varname; do
    [ -z "$varname" ] && continue

    # In bash double-quotes: \$ → literal $, $varname → variable name.
    # So the fixed strings passed to grep are e.g. "::add-mask::$json"
    # and "::add-mask::${json}" — exactly what appears in the workflow file.
    if grep -qF "::add-mask::\$$varname" "$f" 2>/dev/null \
    || grep -qF "::add-mask::\${$varname}" "$f" 2>/dev/null; then
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
