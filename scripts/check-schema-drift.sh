#!/usr/bin/env bash
#
# scripts/check-schema-drift.sh
#
# Bug #3 (Wave 5 Path D Pickup A follow-up) — best-effort warning that
# the Drizzle schema (`backend/src/infrastructure/repository/postgres/
# schema.ts`) has changed since the last `db-push-homelab.sh` run, so
# the operator knows to run db:push BEFORE smoke-testing the new
# deploy.
#
# The Pickup A smoke (2026-05-22) wasted a round-trip because the
# operator-follow-up step from Commit 2.A (`bash scripts/db-push-
# homelab.sh prod`) was missed silently: deploy-homelab.sh rsynced
# the new code, the container restarted, but the agent_scoped_sessions
# table wasn't in the DB — surfacing as an opaque 500 on the first
# mirror GET. This check closes that gap.
#
# Detection mechanism:
#   1. `scripts/db-push-homelab.sh` writes the current HEAD SHA to
#      `${REMOTE_PATH}/.last-db-pushed-commit` on every successful push.
#   2. THIS script reads that marker via SSH, then runs
#      `git diff --quiet <marker>..HEAD -- backend/src/infrastructure/
#      repository/postgres/schema.ts` locally. Any diff = pending push.
#
# Failure modes are SOFT WARNINGS (this script NEVER fails-out — the
# deploy already succeeded):
#   - marker file absent on remote → first-ever deploy after this code
#     lands, or operator never ran the new db-push-homelab.sh
#   - marker SHA unreachable in the local clone → operator re-cloned
#     without the deploy history
#   - SSH read fails / wrong shape → connectivity glitch
#
# Usage (called from the operator-local `scripts/deploy-homelab.sh`):
#
#   bash scripts/check-schema-drift.sh \
#     --ssh-user muhaven \
#     --ssh-host 192.168.1.52 \
#     --ssh-key "$HOME/.ssh/id_muhaven_vm" \
#     --remote-path "/home/muhaven/Project/Fhenix/MuHaven" \
#     --env-tag prod
#
# **Recommended placement: BEFORE the docker rebuild + health check.**
# Calling this after the rebuild means the operator's eyes have already
# moved to the smoke before the warning prints — exactly the failure
# mode that motivated this bundle (DevOps Automator round-1 H-1).
# Calling pre-rebuild gives the operator a chance to abort + run
# db-push first, OR at least to read the warning before their attention
# shifts.
#
# Exits 0 ALWAYS (best-effort; this is observability, not a gate).

set -uo pipefail

SSH_USER=""
SSH_HOST=""
SSH_KEY=""
REMOTE_PATH=""
ENV_TAG=""

print_usage() {
  cat <<'EOF'
Usage:
  bash scripts/check-schema-drift.sh \
    --ssh-user <user> --ssh-host <host> --ssh-key <path> \
    --remote-path <path> --env-tag {prod|stage}

Exits 0 ALWAYS (observability, not a gate). See script header for the
marker mechanism and failure modes.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ssh-user)    SSH_USER="$2"; shift 2 ;;
    --ssh-host)    SSH_HOST="$2"; shift 2 ;;
    --ssh-key)     SSH_KEY="$2"; shift 2 ;;
    --remote-path) REMOTE_PATH="$2"; shift 2 ;;
    --env-tag)     ENV_TAG="$2"; shift 2 ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo "    check-schema-drift: unknown flag '$1' — skipping check"
      exit 0
      ;;
  esac
done

if [[ -z "$SSH_USER" || -z "$SSH_HOST" || -z "$SSH_KEY" || -z "$REMOTE_PATH" || -z "$ENV_TAG" ]]; then
  echo "    check-schema-drift: missing required flag — skipping check"
  exit 0
fi

# DevOps L-3 — env-tag validation. Operator-visible remediation messages
# embed $ENV_TAG verbatim; a typo would echo a non-runnable command.
if [[ "$ENV_TAG" != "prod" && "$ENV_TAG" != "stage" ]]; then
  echo "    check-schema-drift: --env-tag must be 'prod' or 'stage' (got '$ENV_TAG') — skipping check"
  exit 0
fi

SCHEMA_PATH="backend/src/infrastructure/repository/postgres/schema.ts"
SSH_CMD=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)

echo ""
echo "==> Schema-drift check (vs last db-push-homelab.sh run)"

DB_MARKER="$("${SSH_CMD[@]}" "${SSH_USER}@${SSH_HOST}" \
  "cat ${REMOTE_PATH}/.last-db-pushed-commit 2>/dev/null" 2>/dev/null || true)"
DB_MARKER="${DB_MARKER//[$'\r\n\t ']/}"

if [[ -z "$DB_MARKER" ]]; then
  echo "    SOFT WARNING: ${REMOTE_PATH}/.last-db-pushed-commit not found on remote."
  echo "    Cannot compute schema-drift since the last db:push."
  echo "    (Expected on the first deploy after Bug #3 landed — the marker"
  echo "     is populated by the NEXT \`scripts/db-push-homelab.sh $ENV_TAG\` run.)"
  echo "    If schema.ts was touched since the last db:push, run it now BEFORE"
  echo "    smoke-testing — the backend may 500 on queries against new tables."
  exit 0
fi

# SecEng H-1 round-1 — SHA-shape validation BEFORE passing to git.
# Without this gate, a hostile / corrupted marker file could inject
# git option flags via leading `-` or `--exec=` (git's arg parser
# treats `-`-prefixed strings as options in some paths). The marker
# is filesystem-readable to non-root users on the homelab → defense
# in depth even though current threat-model has no attacker there.
if [[ ! "$DB_MARKER" =~ ^[0-9a-f]{40}$ ]]; then
  echo "    SOFT WARNING: marker file content is not a 40-char hex SHA — refusing to use."
  echo "    (Likely cause: corruption or operator wrote it manually with wrong format."
  echo "     Re-run \`scripts/db-push-homelab.sh $ENV_TAG\` to repopulate the marker.)"
  exit 0
fi

if ! git cat-file -e "${DB_MARKER}^{commit}" 2>/dev/null; then
  echo "    SOFT WARNING: remote marker SHA ${DB_MARKER:0:12} not reachable in local clone."
  echo "    (Operator re-cloned without the deploy history, or the commit was force-pushed away.)"
  echo "    Cannot compute schema-drift; if unsure, run scripts/db-push-homelab.sh $ENV_TAG."
  exit 0
fi

git diff --quiet "${DB_MARKER}..HEAD" -- "$SCHEMA_PATH"
DIFF_EXIT=$?
if [[ "$DIFF_EXIT" == "0" ]]; then
  echo "    OK: schema.ts unchanged since last db:push (${DB_MARKER:0:12})."
elif [[ "$DIFF_EXIT" == "1" ]]; then
  echo "    ⚠  ⚠  ⚠  schema.ts CHANGED between ${DB_MARKER:0:12}..HEAD  ⚠  ⚠  ⚠"
  echo ""
  echo "    Run BEFORE smoke-testing:"
  echo "      bash scripts/db-push-homelab.sh $ENV_TAG"
  echo ""
  echo "    Touching commits:"
  git log --oneline "${DB_MARKER}..HEAD" -- "$SCHEMA_PATH" | sed 's/^/      /'
  echo ""
else
  # DevOps L-3: git diff exits 128 on bad revision spec (e.g. HEAD has
  # been rewritten leaving the marker dangling); any other non-{0,1}
  # status is git-internal. Both collapse to "soft warning" with the
  # numeric exit for diagnosability.
  echo "    SOFT WARNING: git diff exited $DIFF_EXIT (128 = bad revision; other = git internal)."
  echo "    Cannot detect drift; re-run \`scripts/db-push-homelab.sh $ENV_TAG\` to repopulate the marker."
fi

exit 0
