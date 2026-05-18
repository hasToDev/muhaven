#!/usr/bin/env bash
# cleanup-tokens-homelab.sh
#
# SSH wrapper around backend/scripts/cleanup-obsolete-tokens.ts on the
# homelab Docker stack. Two-pass per the script's safety contract:
#
#   1. bash scripts/cleanup-tokens-homelab.sh dry-run
#         → resolves obsolete catalog rows, prints addresses + per-table
#           dependent-row counts. NO writes.
#
#   2. bash scripts/cleanup-tokens-homelab.sh execute 0xabc,0xdef,...
#         → re-resolves, refuses if the resolved set doesn't match the
#           --confirm-addresses list, then DELETEs across 6 tables.
#
# Default target is PROD (matches `feedback_prod_default_no_stage`).
# Pass `--stage` as the last arg to target the staging stack instead:
#   bash scripts/cleanup-tokens-homelab.sh dry-run --stage
#   bash scripts/cleanup-tokens-homelab.sh execute 0xabc,0xdef --stage
#
# Requires the same SSH key + homelab access that deploy-homelab.sh
# uses (~/.ssh/id_muhaven_vm).

set -euo pipefail

REMOTE_HOST="192.168.1.52"
REMOTE_USER="muhaven"
SSH_KEY="$HOME/.ssh/id_muhaven_vm"
SSH_CMD="ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"

MODE="${1:-}"
ARG2="${2:-}"
ARG3="${3:-}"

# --stage flag may appear as $2 (dry-run) or $3 (execute). Normalize.
ENV_FLAG="prod"
for a in "$ARG2" "$ARG3"; do
  if [[ "$a" == "--stage" ]]; then ENV_FLAG="stage"; fi
done

if [[ "$ENV_FLAG" == "prod" ]]; then
  COMPOSE_FILE="docker-compose.yml"
  COMPOSE_PROJECT="muhaven"
  REMOTE_PATH="/home/muhaven/Project/Fhenix/MuHaven"
else
  COMPOSE_FILE="docker-compose.stage.yml"
  COMPOSE_PROJECT="muhaven-stage"
  REMOTE_PATH="/home/muhaven/Project/Fhenix/MuHaven-stage"
fi

usage() {
  cat <<EOF
Usage:
  bash scripts/cleanup-tokens-homelab.sh dry-run [--stage]
  bash scripts/cleanup-tokens-homelab.sh execute 0xabc,0xdef,... [--stage]

Default target: prod ($COMPOSE_PROJECT @ $REMOTE_PATH on $REMOTE_HOST).
Pass --stage as the last arg to target the staging stack.
EOF
  exit 2
}

if [[ -z "$MODE" ]]; then usage; fi

# Verify SSH reachability first so we fail fast on a wrong key / firewall.
if ! $SSH_CMD "${REMOTE_USER}@${REMOTE_HOST}" "echo ok" >/dev/null 2>&1; then
  echo "ERROR: cannot SSH to ${REMOTE_USER}@${REMOTE_HOST} using $SSH_KEY"
  echo "  Verify: ssh -i $SSH_KEY ${REMOTE_USER}@${REMOTE_HOST} 'echo hi'"
  exit 1
fi

case "$MODE" in
  dry-run)
    echo "==> [$ENV_FLAG] dry-run cleanup-obsolete-tokens on $REMOTE_HOST"
    echo "    (no writes; will print resolved addresses to paste back)"
    echo
    $SSH_CMD "${REMOTE_USER}@${REMOTE_HOST}" \
      "cd ${REMOTE_PATH} && docker compose -f ${COMPOSE_FILE} -p ${COMPOSE_PROJECT} exec -T backend pnpm tsx scripts/cleanup-obsolete-tokens.ts --dry-run"
    ;;

  execute)
    if [[ -z "$ARG2" || "$ARG2" == "--stage" ]]; then
      echo "ERROR: execute requires a comma-separated address list."
      echo "       Run dry-run first; paste the addresses from its output."
      usage
    fi
    ADDRS="$ARG2"
    echo "==> [$ENV_FLAG] EXECUTE cleanup-obsolete-tokens on $REMOTE_HOST"
    echo "    --confirm-addresses=$ADDRS"
    echo "    (THIS WILL DELETE ROWS. Ctrl-C now to abort.)"
    sleep 3
    echo
    $SSH_CMD "${REMOTE_USER}@${REMOTE_HOST}" \
      "cd ${REMOTE_PATH} && docker compose -f ${COMPOSE_FILE} -p ${COMPOSE_PROJECT} exec -T backend pnpm tsx scripts/cleanup-obsolete-tokens.ts --confirm-addresses=${ADDRS}"
    ;;

  *)
    usage
    ;;
esac
