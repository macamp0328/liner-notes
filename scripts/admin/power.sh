#!/usr/bin/env bash
set -euo pipefail

# Scale-to-zero power switch for the k3s node. Invokes the instance-scheduler
# Lambda (see infra/terraform/scheduler.tf) with one of four actions:
#
#   on     start the node and keep it up (pauses the nightly schedule)
#   off    stop the node and keep it down (pauses the nightly schedule)
#   auto   re-arm the nightly stop/start cost-saver and start the node now
#   status read-only: report instance state + each schedule's state
#
# Uses the AWS CLI's default/operator profile (honors AWS_PROFILE if set). The
# operator principal needs lambda:InvokeFunction on the Lambda — granted in the
# operator policy outside terraform (see infra/RUNBOOK.md).

if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
fi

: "${AWS_REGION:=us-east-1}"
: "${SCHEDULER_LAMBDA_NAME:=liner-notes-instance-scheduler}"

MODE="${1:-}"
case "$MODE" in
on | off | auto | status) ;;
*)
  echo "usage: $0 <on|off|auto|status>" >&2
  exit 2
  ;;
esac

RESPONSE_FILE="$(mktemp)"
trap 'rm -f "$RESPONSE_FILE"' EXIT

INVOKE_META="$(aws lambda invoke \
  --function-name "$SCHEDULER_LAMBDA_NAME" \
  --region "$AWS_REGION" \
  --cli-binary-format raw-in-base64-out \
  --payload "{\"action\":\"$MODE\"}" \
  "$RESPONSE_FILE")"

jq . "$RESPONSE_FILE"

if echo "$INVOKE_META" | jq -e '.FunctionError' >/dev/null 2>&1; then
  echo "Lambda reported a function error (see payload above)." >&2
  exit 1
fi
