#!/usr/bin/env bash
# homelab-logs.sh
#
# Quick SSH helper for grabbing recent docker compose logs from one or
# more services on the homelab (prod or stage). Used for triage when
# the MCP smoke surfaces a structured fallback reason and the operator
# needs the underlying server-side stack trace.
#
# Usage:
#   bash scripts/homelab-logs.sh <service> [--since 5m] [--tail 200] [--stage]
#
# Examples:
#   # last 200 lines from backend on prod
#   bash scripts/homelab-logs.sh backend
#
#   # last 5 minutes from backend + fhe-worker (diagnose encrypt-shares 500)
#   bash scripts/homelab-logs.sh backend,fhe-worker --since 5m
#
#   # follow stage logs live
#   bash scripts/homelab-logs.sh backend --tail 0 --since 0s --stage
#
# Default tail: 200 lines. Default --since: omitted (full tail).
# Default target: prod (matches `feedback_prod_default_no_stage`).

set -euo pipefail

REMOTE_HOST="192.168.1.52"
REMOTE_USER="muhaven"
SSH_KEY="$HOME/.ssh/id_muhaven_vm"
SSH_CMD="ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"

SERVICES="${1:-}"
shift || true

TAIL="200"
SINCE=""
ENV_FLAG="prod"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tail) TAIL="$2"; shift 2 ;;
    --since) SINCE="$2"; shift 2 ;;
    --stage) ENV_FLAG="stage"; shift ;;
    *)
      echo "ERROR: unknown flag '$1'"
      exit 2
      ;;
  esac
done

if [[ -z "$SERVICES" ]]; then
  cat <<EOF
Usage:
  bash scripts/homelab-logs.sh <service[,service...]> [--since 5m] [--tail 200] [--stage]

Known services (docker compose names):
  backend          REST API
  fhe-worker       CoFHE encrypt/decrypt service
  nav-worker       NAV ingest worker
  postgres         database
EOF
  exit 2
fi

if [[ "$ENV_FLAG" == "prod" ]]; then
  COMPOSE_FILE="docker-compose.yml"
  COMPOSE_PROJECT="muhaven"
  REMOTE_PATH="/home/muhaven/Project/Fhenix/MuHaven"
else
  COMPOSE_FILE="docker-compose.stage.yml"
  COMPOSE_PROJECT="muhaven-stage"
  REMOTE_PATH="/home/muhaven/Project/Fhenix/MuHaven-stage"
fi

# Validate the comma-list — only [a-z0-9-] segments. Block injection
# via crafted service names.
if ! [[ "$SERVICES" =~ ^[a-z0-9-]+(,[a-z0-9-]+)*$ ]]; then
  echo "ERROR: services list must be comma-separated [a-z0-9-]+ (got '$SERVICES')"
  exit 1
fi
SERVICES_ARGS="${SERVICES//,/ }"

# Build the remote docker compose logs command.
SINCE_ARG=""
if [[ -n "$SINCE" ]]; then
  SINCE_ARG="--since $SINCE"
fi

if ! $SSH_CMD "${REMOTE_USER}@${REMOTE_HOST}" "echo ok" >/dev/null 2>&1; then
  echo "ERROR: cannot SSH to ${REMOTE_USER}@${REMOTE_HOST} using $SSH_KEY"
  exit 1
fi

echo "==> [$ENV_FLAG] docker compose logs"
echo "    services: $SERVICES_ARGS"
echo "    tail:     $TAIL  since: ${SINCE:-<all>}"
echo

$SSH_CMD "${REMOTE_USER}@${REMOTE_HOST}" \
  "cd ${REMOTE_PATH} && docker compose -f ${COMPOSE_FILE} -p ${COMPOSE_PROJECT} logs --tail ${TAIL} ${SINCE_ARG} ${SERVICES_ARGS}"
