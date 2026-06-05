#!/usr/bin/env bash
set -euo pipefail

# Mints the KUBECONFIG_B64 GitHub secret the CD workflow (issue #120) uses to
# authenticate to the k3s API as the scoped `github-deployer` ServiceAccount
# (see infra/k8s/deploy/github-deployer.yaml).
#
# Prerequisites — run this from the repo root on your laptop with:
#   1. infra/k8s/deploy/github-deployer.yaml already applied to the cluster.
#   2. KUBECONFIG pointed at the admin kubeconfig (~/.kube/liner-notes-prod.yaml).
#   3. The SSM 6443 port-forward from RUNBOOK Step 4b still running.
#
# It reads the SA token from the github-deployer-token Secret, takes the cluster
# CA from the admin kubeconfig (NOT the Secret's ca.crt — the admin config's CA
# is the trust anchor already proven to validate the serving cert at
# https://127.0.0.1:6443, see RUNBOOK Step 4), templates a token-auth kubeconfig,
# and prints its base64 to STDOUT. All diagnostics go to STDERR so the output can
# be piped straight into gh:
#
#   scripts/admin/mint-deploy-kubeconfig.sh | gh secret set KUBECONFIG_B64 --repo macamp0328/liner-notes
#
# See infra/RUNBOOK.md "CD — cluster bootstrap".

if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
fi

: "${NAMESPACE:=liner-notes}"
: "${SA_NAME:=github-deployer}"
: "${TOKEN_SECRET:=github-deployer-token}"
: "${API_SERVER:=https://127.0.0.1:6443}"

if [ "$#" -ne 0 ]; then
  echo "usage: $0   (no args; configured via NAMESPACE/SA_NAME/TOKEN_SECRET/API_SERVER env vars)" >&2
  exit 2
fi

command -v kubectl >/dev/null 2>&1 || {
  echo "error: kubectl not found on PATH" >&2
  exit 1
}

# The token controller fills the Secret asynchronously after the SA/Secret are
# created, so a read right after `kubectl apply` can come back empty. Poll for it.
echo "Waiting for the $TOKEN_SECRET token to populate..." >&2
token_b64=""
attempts=0
while [ "$attempts" -lt 30 ]; do
  token_b64="$(kubectl -n "$NAMESPACE" get secret "$TOKEN_SECRET" \
    -o jsonpath='{.data.token}' 2>/dev/null || true)"
  [ -n "$token_b64" ] && break
  attempts=$((attempts + 1))
  sleep 1
done

if [ -z "$token_b64" ]; then
  echo "error: the $TOKEN_SECRET token never populated in namespace $NAMESPACE." >&2
  echo "       Check that github-deployer.yaml is applied, KUBECONFIG points at the" >&2
  echo "       admin kubeconfig, and the SSM 6443 port-forward (RUNBOOK Step 4b) is up." >&2
  exit 1
fi

# Decode the token cluster-side with kubectl's go-template `base64decode` so the
# script never depends on the platform's `base64` decode flag (GNU/newer-macOS
# accept `-d`/`--decode`, but older BSD/macOS `base64` only accepts `-D`).
token="$(kubectl -n "$NAMESPACE" get secret "$TOKEN_SECRET" \
  -o go-template='{{ .data.token | base64decode }}')"

# certificate-authority-data straight from the admin kubeconfig (already base64,
# already proven correct for https://127.0.0.1:6443).
ca_data="$(kubectl config view --raw \
  -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')"

if [ -z "$ca_data" ]; then
  echo "error: could not read certificate-authority-data from the current kubeconfig." >&2
  echo "       Set KUBECONFIG to the admin kubeconfig (~/.kube/liner-notes-prod.yaml)." >&2
  exit 1
fi

kubeconfig="$(
  cat <<EOF
apiVersion: v1
kind: Config
clusters:
  - name: liner-notes-prod
    cluster:
      server: ${API_SERVER}
      certificate-authority-data: ${ca_data}
contexts:
  - name: ${SA_NAME}@liner-notes-prod
    context:
      cluster: liner-notes-prod
      namespace: ${NAMESPACE}
      user: ${SA_NAME}
current-context: ${SA_NAME}@liner-notes-prod
users:
  - name: ${SA_NAME}
    user:
      token: ${token}
EOF
)"

echo "Minted kubeconfig for serviceaccount:$NAMESPACE:$SA_NAME at $API_SERVER" >&2
echo "Piping the base64 value to STDOUT (set it as the KUBECONFIG_B64 GitHub secret)." >&2

# No GNU-only `base64 -w0`; tr strips wrapping for a single-line secret value.
printf '%s' "$kubeconfig" | base64 | tr -d '\n'
