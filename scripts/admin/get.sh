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

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <path>   e.g. $0 /api/v1/admin/lyrics/status" >&2
  exit 2
fi

curl -fsS \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$GRAPH_SERVICE_URL$1" \
  | jq .
