#!/usr/bin/env bash
#
# scripts/sql/install-pgcrypto-homelab.sh
#
# Wave 5 Option D · Commit 2 — one-shot operator script to enable the
# `pgcrypto` extension on the homelab Postgres. The backend's boot path
# already calls `CREATE EXTENSION IF NOT EXISTS pgcrypto` (see
# `backend/src/dev-server.ts` + `backend/src/infrastructure/repository/
# postgres/pgcrypto.ts::ensurePgcryptoExtension`), so this script is a
# fallback for the case where the auto-boot path failed (eg the muhaven
# DB role lost extension-creation privileges, or the failure log went
# unnoticed and an operator wants to bootstrap pgcrypto without
# restarting the backend container).
#
# Idempotent — `CREATE EXTENSION IF NOT EXISTS pgcrypto` is a no-op on
# already-installed extensions.
#
# Usage:
#   bash scripts/sql/install-pgcrypto-homelab.sh prod    # api.muhaven.app
#   bash scripts/sql/install-pgcrypto-homelab.sh stage   # api-stage.muhaven.app
#
# Branch-guarded (prod → master, stage → agenticwave) to match
# `option-d-c1-migration.sh` + `db-push-homelab.sh` conventions.
# Override with FORCE_BRANCH=1 for one-off interventions.

set -euo pipefail

ENV_ARG="${1:-}"
if [[ "$ENV_ARG" != "prod" && "$ENV_ARG" != "stage" ]]; then
  cat >&2 <<'USAGE'
Usage: bash scripts/sql/install-pgcrypto-homelab.sh {prod|stage}

  prod  → muhaven stack (master branch guard)
  stage → muhaven-stage stack (agenticwave branch guard)

Required: ssh access to the homelab (192.168.1.52) as the muhaven user
with the standard ~/.ssh/id_muhaven_vm key. Reads no env from this
machine — runs CREATE EXTENSION via `docker compose exec postgres psql`.

Override branch guard: FORCE_BRANCH=1 bash scripts/sql/install-pgcrypto-homelab.sh prod
USAGE
  exit 1
fi

if [[ "$ENV_ARG" == "prod" ]]; then
  EXPECTED_BRANCH="master"
  COMPOSE_FILE="docker-compose.yml"
  PROJECT_NAME="muhaven"
  PROJECT_DIR="/home/muhaven/Project/Fhenix/MuHaven"
else
  EXPECTED_BRANCH="agenticwave"
  COMPOSE_FILE="docker-compose.stage.yml"
  PROJECT_NAME="muhaven-stage"
  PROJECT_DIR="/home/muhaven/Project/Fhenix/MuHaven-stage"
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
if [[ -z "$CURRENT_BRANCH" ]]; then
  echo "ERROR: not in a git checkout. Run from the repo root." >&2
  exit 1
fi
if [[ "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" && "${FORCE_BRANCH:-0}" != "1" ]]; then
  echo "ERROR: $ENV_ARG pgcrypto bootstrap requires branch '$EXPECTED_BRANCH', currently on '$CURRENT_BRANCH'." >&2
  echo "  override with FORCE_BRANCH=1 bash scripts/sql/install-pgcrypto-homelab.sh $ENV_ARG" >&2
  exit 1
fi

SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_muhaven_vm}"
SSH_HOST="${SSH_HOST:-muhaven@192.168.1.52}"

echo "[$ENV_ARG] Running CREATE EXTENSION IF NOT EXISTS pgcrypto on $PROJECT_NAME..."
ssh -i "$SSH_KEY" "$SSH_HOST" \
  "docker compose -f $PROJECT_DIR/$COMPOSE_FILE -p $PROJECT_NAME exec -T postgres \
    psql -U muhaven -d muhaven -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto;'"

echo "[$ENV_ARG] Verifying pgp_sym_encrypt is callable..."
ssh -i "$SSH_KEY" "$SSH_HOST" \
  "docker compose -f $PROJECT_DIR/$COMPOSE_FILE -p $PROJECT_NAME exec -T postgres \
    psql -U muhaven -d muhaven -c \"SELECT octet_length(pgp_sym_encrypt('ping', 'k')) > 0 AS pgcrypto_ok;\""

echo "[$ENV_ARG] pgcrypto bootstrap complete."
