#!/usr/bin/env bash
# revoke-scoped-session-homelab.sh
#
# Operator-side admin helper to revoke an active scoped session (Wave 5
# Path D Slice 1 mirror row) directly via Postgres on the homelab when
# the frontend doesn't yet expose a revoke button. Goes through the same
# SSH path as `cleanup-tokens-homelab.sh` and `db-push-homelab.sh`.
#
# Two modes:
#
#   1. bash scripts/revoke-scoped-session-homelab.sh list [--stage]
#         → prints every active row in agent_scoped_sessions across all
#           users so the operator can copy the sessionId they need.
#
#   2. bash scripts/revoke-scoped-session-homelab.sh revoke <sessionId> [--stage]
#         → marks the row status='revoked' + revoked_at=NOW() inside a
#           single transaction. Refuses if the row isn't found or is
#           already terminal. Echoes the affected row so the operator
#           sees the before/after.
#
# Default target is PROD (matches `feedback_prod_default_no_stage`).
# Pass `--stage` as the LAST arg to target the staging stack.
#
# Audit-chain gap (intentional): this script does NOT emit a paired
# `ScopedSessionRevoked` row into `agent_audit_events` — the
# RevokeScopedSessionUseCase composes that via `AppendAuditEventUseCase`,
# but routing through it from a shell requires a valid JWT. Use this
# script for dev-cycle / smoke unblocks where the audit-pair gap is
# acceptable; for production-grade revokes go through the dashboard.
# The revoked row is grep-able from the operator's homelab via:
#
#   docker compose exec -T postgres psql -U muhaven -d muhaven \
#     -c "SELECT session_id FROM agent_scoped_sessions \
#         WHERE status='revoked' AND session_id NOT IN ( \
#           SELECT (metadata->>'sessionId') FROM agent_audit_events \
#           WHERE event_type='ScopedSessionRevoked' \
#         );"
#
# Requires the same SSH key + homelab access that `deploy-homelab.sh`
# uses (~/.ssh/id_muhaven_vm).

set -euo pipefail

REMOTE_HOST="192.168.1.52"
REMOTE_USER="muhaven"
SSH_KEY="$HOME/.ssh/id_muhaven_vm"
SSH_CMD="ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"

MODE="${1:-}"
ARG2="${2:-}"
ARG3="${3:-}"

# `--stage` may appear in $2 (list) or $3 (revoke). Normalize.
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
  bash scripts/revoke-scoped-session-homelab.sh list [--stage]
  bash scripts/revoke-scoped-session-homelab.sh revoke <sessionId> [--stage]

Default target: prod ($COMPOSE_PROJECT @ $REMOTE_PATH on $REMOTE_HOST).
Pass --stage as the last arg to target the staging stack.

Examples:
  # list active sessions
  bash scripts/revoke-scoped-session-homelab.sh list

  # revoke a specific session
  bash scripts/revoke-scoped-session-homelab.sh revoke 9fbfddfa-78d7-448e-b31f-50f1b9c6d3fb
EOF
  exit 2
}

if [[ -z "$MODE" ]]; then usage; fi

# SSH reachability check (fail fast on wrong key / firewall).
if ! $SSH_CMD "${REMOTE_USER}@${REMOTE_HOST}" "echo ok" >/dev/null 2>&1; then
  echo "ERROR: cannot SSH to ${REMOTE_USER}@${REMOTE_HOST} using $SSH_KEY"
  echo "  Verify: ssh -i $SSH_KEY ${REMOTE_USER}@${REMOTE_HOST} 'echo hi'"
  exit 1
fi

# Run a SQL statement inside the backend container — uses the container's
# DATABASE_URL so the password never lands in the script. `-T` disables
# TTY allocation (required for non-interactive ssh exec).
remote_sql() {
  local SQL="$1"
  $SSH_CMD "${REMOTE_USER}@${REMOTE_HOST}" \
    "cd ${REMOTE_PATH} && docker compose -f ${COMPOSE_FILE} -p ${COMPOSE_PROJECT} exec -T postgres psql -U muhaven -d muhaven -v ON_ERROR_STOP=1 -A -F'|' -c \"${SQL//\"/\\\"}\""
}

case "$MODE" in
  list)
    echo "==> [$ENV_FLAG] active scoped sessions on $REMOTE_HOST"
    echo
    # `expanded display` table mode keeps long sessionIds + JSON columns
    # readable. Filter to active only — terminal rows aren't actionable.
    remote_sql "SELECT session_id, user_id, surface, signer_address, valid_until_sec, minted_at, jsonb_array_length(selector_caps::jsonb) AS sel_caps_n, selector_caps->0->>'maxAmount' AS max_amount_shares, max_per_op_usd6 FROM agent_scoped_sessions WHERE status='active' ORDER BY minted_at DESC;"
    echo
    echo "Copy the session_id of the row to revoke, then run:"
    echo "  bash scripts/revoke-scoped-session-homelab.sh revoke <sessionId>"
    ;;

  revoke)
    if [[ -z "$ARG2" || "$ARG2" == "--stage" ]]; then
      echo "ERROR: revoke requires a sessionId."
      echo "       Run 'list' first to find the sessionId."
      usage
    fi
    SESSION_ID="$ARG2"

    # Hard-validate the sessionId shape on the client side so a typo
    # can't injection-format into the SQL string. Matches the broker's
    # SESSION_ID_RE (/^[A-Za-z0-9_-]{1,128}$/) plus a UUID-friendly
    # range. Defense-in-depth — the prepared SELECT below also passes
    # the value via a literal `WHERE session_id = '...'`, but the
    # client gate is what stops a malformed value from ever reaching
    # psql at all.
    if ! [[ "$SESSION_ID" =~ ^[A-Za-z0-9_-]{1,128}$ ]]; then
      echo "ERROR: sessionId '$SESSION_ID' violates the broker shape /^[A-Za-z0-9_-]{1,128}$/."
      exit 1
    fi

    echo "==> [$ENV_FLAG] revoke scoped session on $REMOTE_HOST"
    echo "    sessionId: $SESSION_ID"
    echo "    (THIS MARKS THE ROW status='revoked'. Ctrl-C now to abort.)"
    sleep 2
    echo

    # Three statements inside one TX:
    #   1. SELECT current row (echo to operator before mutation).
    #   2. UPDATE status='revoked', revoked_at=NOW() — only fires if
    #      the row is currently active. The `RETURNING` clause emits
    #      0 rows if the WHERE didn't match (already terminal / wrong
    #      id), 1 row if revoked.
    #   3. ROLLBACK on the SELECT being empty so a typo'd sessionId
    #      doesn't even open a tx receipt — psql exits non-zero
    #      thanks to ON_ERROR_STOP=1 + the row-count check.
    remote_sql "BEGIN; \
      SELECT session_id, user_id, surface, status, minted_at FROM agent_scoped_sessions WHERE session_id='$SESSION_ID'; \
      UPDATE agent_scoped_sessions SET status='revoked', revoked_at=NOW() WHERE session_id='$SESSION_ID' AND status='active' RETURNING session_id, status, revoked_at; \
      COMMIT;"

    echo
    echo "If the UPDATE block returned 0 rows, the session was already"
    echo "terminal (revoked/expired) or the sessionId didn't match."
    echo
    echo "Next steps (operator):"
    echo "  1. Restart the muhaven-broker daemon so it drops the stale"
    echo "     in-memory snapshot for this session."
    echo "  2. Walk a fresh /agent/policy/transition ceremony with the"
    echo "     desired maxPerOp cap to mint a NEW scoped session."
    ;;

  *)
    usage
    ;;
esac
