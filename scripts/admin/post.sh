#!/usr/bin/env bash
set -euo pipefail

if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
fi

: "${ADMIN_TOKEN:?ADMIN_TOKEN is required (set in .env.local or exported)}"
: "${GRAPH_SERVICE_URL:=http://localhost:3000}"
: "${CURL_MAX_TIME:=120}"

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <path>   e.g. $0 /api/v1/admin/lyrics/enrich" >&2
  exit 2
fi

# --config - feeds the Authorization header via curl's stdin so the token never lands on argv
# (readable via `ps`). --fail-with-body still fails on 4xx/5xx but keeps the response body
# (curl >= 7.76). --connect-timeout/--max-time bound a hung or unreachable origin. Capture the
# body + exit code so a non-JSON error page (e.g. a Cloudflare 5xx) is printed raw instead of
# swallowed by jq, while curl's status still propagates as the script's exit code.
status=0
response="$(
  curl --fail-with-body -sS -X POST \
    --connect-timeout 10 \
    --max-time "$CURL_MAX_TIME" \
    --config - \
    "$GRAPH_SERVICE_URL$1" <<EOF
header = "Authorization: Bearer $ADMIN_TOKEN"
EOF
)" || status=$?

printf '%s' "$response" | jq . 2>/dev/null || printf '%s\n' "$response"

exit "$status"
