#!/usr/bin/env bash
#
# scripts/db-push-homelab.sh
#
# Runs `pnpm db:push` inside the homelab backend container to apply
# pending Drizzle schema changes (this repo uses declarative `db:push`
# — see CLAUDE.md "Backend stack" — not versioned migrations).
#
# Use after any schema.ts edit lands on the deployed branch, OR after
# pulling a commit that widened the schema. Pick B 2026-05-23 added a
# nullable `rwa_tokens.yield_snapshot_address` column → safe additive
# push, no data migration hazard.
#
# Usage:
#   bash scripts/db-push-homelab.sh prod
#   bash scripts/db-push-homelab.sh stage
#
# Safety posture:
#   - Branch-guarded (prod → master, stage → agenticwave) to mirror
#     deploy-homelab.sh's `EXPECTED_BRANCH` — refuses to push if local
#     branch doesn't match. The stage branch tracks Wave 4's active
#     development branch (`agenticwave`) per the model documented in
#     development/STAGING.md; it will rotate to the next active branch
#     when Wave 4 / Wave 5 merges back into master. Bypass for one-offs
#     via FORCE_BRANCH=1.
#   - Uses --frozen + drizzle-kit's idempotent push: re-runs are
#     safe; no-op when schema is already in sync.
#   - The backend container's `pnpm db:push` reads DATABASE_URL from
#     its own env file; this script never touches credentials directly.

set -euo pipefail

ENV_ARG="${1:-}"
if [[ "$ENV_ARG" != "prod" && "$ENV_ARG" != "stage" ]]; then
  echo "Usage: $0 {prod|stage}"
  echo
  echo "  prod  → ssh muhaven@192.168.1.52, MuHaven/docker-compose.yml, project=muhaven"
  echo "  stage → ssh muhaven@192.168.1.52, MuHaven-stage/docker-compose.stage.yml, project=muhaven-stage"
  exit 1
fi

REMOTE_USER="muhaven"
REMOTE_HOST="192.168.1.52"
SSH_KEY="$HOME/.ssh/id_muhaven_vm"

if [[ "$ENV_ARG" == "prod" ]]; then
  COMPOSE_FILE="docker-compose.yml"
  COMPOSE_PROJECT="muhaven"
  REMOTE_PATH="/home/muhaven/Project/Fhenix/MuHaven"
  EXPECTED_BRANCH="master"
else
  COMPOSE_FILE="docker-compose.stage.yml"
  COMPOSE_PROJECT="muhaven-stage"
  REMOTE_PATH="/home/muhaven/Project/Fhenix/MuHaven-stage"
  # Must match `scripts/deploy-homelab.sh`'s EXPECTED_BRANCH for stage.
  # Wave 4/5 development branch model: stage tracks `agenticwave` until
  # active development merges back into master. Rotates with the
  # active branch per development/STAGING.md.
  EXPECTED_BRANCH="agenticwave"
fi

# Branch guard — mirrors deploy-homelab.sh:114
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
if [[ -z "$CURRENT_BRANCH" ]]; then
  echo "ERROR: not in a git checkout. Run from the repo root."
  exit 1
fi
if [[ "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" && "${FORCE_BRANCH:-0}" != "1" ]]; then
  echo "ERROR: $ENV_ARG db:push requires branch '$EXPECTED_BRANCH', currently on '$CURRENT_BRANCH'."
  echo "  override with FORCE_BRANCH=1 bash scripts/db-push-homelab.sh $ENV_ARG"
  exit 1
fi

if [[ ! -f "$SSH_KEY" ]]; then
  echo "ERROR: SSH key not found at $SSH_KEY"
  echo "  ssh-keygen -t ed25519 -f \"$SSH_KEY\" -C \"muhaven-homelab\""
  echo "  ssh-copy-id -i \"${SSH_KEY}.pub\" ${REMOTE_USER}@${REMOTE_HOST}"
  exit 1
fi

SSH_CMD=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)

echo "==> db:push on $ENV_ARG"
echo "    host:            ${REMOTE_USER}@${REMOTE_HOST}"
echo "    compose file:    $COMPOSE_FILE"
echo "    compose project: $COMPOSE_PROJECT"
echo "    remote path:     $REMOTE_PATH"
echo

# Pre-flight: confirm the backend container is actually running.
# `docker compose ps -q backend` prints the container id on a hit,
# empty on a miss. A non-running backend would otherwise drop us into
# a useless "no such container" error mid-exec.
echo "==> pre-flight: backend container status"
BACKEND_CID=$("${SSH_CMD[@]}" "${REMOTE_USER}@${REMOTE_HOST}" \
  "docker compose -f ${REMOTE_PATH}/${COMPOSE_FILE} -p ${COMPOSE_PROJECT} ps -q backend" \
  || true)
if [[ -z "$BACKEND_CID" ]]; then
  echo "ERROR: backend container is not running on $ENV_ARG."
  echo "  Deploy first: pnpm run deploy:homelab${ENV_ARG/prod/}"
  echo "  (or: pnpm run deploy:homelab:stage)"
  exit 1
fi
echo "    backend container: ${BACKEND_CID:0:12}"
echo

# Run the push by invoking drizzle-kit DIRECTLY rather than going
# through `pnpm db:push`. Why: the backend image was built with
# `corepack prepare pnpm@latest --activate`, which baked a Node-20-
# compatible pnpm AT IMAGE BUILD TIME. At runtime exec, the pnpm
# shim re-resolves `latest` against the live registry and pulls
# pnpm@11.x — which requires Node v22.13 and crashes on the
# container's Node 20 with `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`.
# Invoking drizzle-kit through `node_modules/.bin/` skips the entire
# corepack/pnpm dance. `package.json:db:push` is literally just
# `drizzle-kit push` (no other side effects), so the two paths are
# equivalent in outcome.
#
# Longer-term fix (separate commit): pin `"packageManager":
# "pnpm@9.15.4"` in `backend/package.json` so corepack stops
# resolving to `latest`. Until that lands, the direct invocation
# is the durable path.
#
# `exec -T` disables TTY allocation (no PTY needed for a one-shot
# script). drizzle-kit's push prints the SQL it ran.
echo "==> running: drizzle-kit push (inside backend container, bypassing pnpm/corepack)"
"${SSH_CMD[@]}" "${REMOTE_USER}@${REMOTE_HOST}" \
  "docker compose -f ${REMOTE_PATH}/${COMPOSE_FILE} -p ${COMPOSE_PROJECT} exec -T backend node_modules/.bin/drizzle-kit push"

echo
echo "==> done. Verify with:"
echo "  ssh -i \"$SSH_KEY\" ${REMOTE_USER}@${REMOTE_HOST} \\"
echo "    'docker compose -f ${REMOTE_PATH}/${COMPOSE_FILE} -p ${COMPOSE_PROJECT} exec -T postgres \\"
echo "       psql -U muhaven -d muhaven -c \"\\d rwa_tokens\"'"
