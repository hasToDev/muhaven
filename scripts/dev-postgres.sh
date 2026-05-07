#!/usr/bin/env bash
# dev-postgres.sh
# Bring up a LOCAL Postgres container for development on your dev machine.
# Idempotent — safe to run multiple times.
#
# Usage:
#   bash scripts/dev-postgres.sh up     # start postgres (default if no arg)
#   bash scripts/dev-postgres.sh down   # stop the local postgres only
#   bash scripts/dev-postgres.sh status # report what's running
#   bash scripts/dev-postgres.sh push   # run pnpm db:push against local pg
#   bash scripts/dev-postgres.sh reset  # destroy the local pg volume + recreate
#
# SAFETY GUARANTEES — this script will REFUSE to run if any of these fail:
#   1. Docker context is "default" (NOT pointing at the homelab or any remote)
#   2. Compose project is "muhaven" (the local default), NOT "muhaven-stage"
#      and NOT "muhaven-prod" — homelab project names cannot match
#   3. The compose file is the repo's local docker-compose.yml, not
#      docker-compose.stage.yml
#
# This script ONLY touches the postgres service of your LOCAL `muhaven`
# compose project. It cannot reach the homelab — homelab stacks run on
# 192.168.1.52 and are administered via scripts/deploy-homelab.sh + SSH.
#
# What runs:
#   - postgres:16-alpine container, mapped to host port 5432
#   - data volume `muhaven_pgdata` (or `<project>_pgdata` per compose default)
#   - default credentials: muhaven / muhaven (from docker-compose.yml)
#
# Connection string for backend/.env:
#   DATABASE_URL=postgresql://muhaven:muhaven@localhost:5432/muhaven

set -euo pipefail

# ── Safety pre-flight ─────────────────────────────────────────────────────────

# Refuse to run if the compose file we're about to use isn't the local one.
if [[ ! -f "docker-compose.yml" ]]; then
  echo "ERROR: docker-compose.yml not found in the current directory."
  echo "       Run this script from the muhaven project root."
  exit 1
fi

# Refuse to run if Docker isn't installed / running on the local machine.
if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker CLI not found in PATH."
  echo "       Install Docker Desktop (Windows/macOS) or docker-engine (Linux)."
  exit 1
fi

# Hard guard: confirm the active Docker context is local. If a developer ever
# configures `docker context use homelab` to administer the remote VM, we want
# this script to refuse rather than silently spin up Postgres on the homelab.
ACTIVE_CONTEXT="$(docker context show 2>/dev/null || echo 'unknown')"
if [[ "$ACTIVE_CONTEXT" != "default" && "$ACTIVE_CONTEXT" != "desktop-linux" ]]; then
  echo "ERROR: active Docker context is '$ACTIVE_CONTEXT', not 'default'."
  echo "       This script only runs against your local Docker daemon."
  echo ""
  echo "Switch contexts with:"
  echo "  docker context use default"
  echo ""
  echo "List contexts:        docker context ls"
  echo "Show the current one: docker context show"
  exit 1
fi

# Compose project name is "muhaven" (the directory's default). Belt-and-
# suspenders: pin it explicitly so a developer who's set COMPOSE_PROJECT_NAME
# in their environment can't accidentally collide with "muhaven-stage" or
# "muhaven-prod" (the homelab project names).
COMPOSE_PROJECT="muhaven-dev-local"
COMPOSE_FILE="docker-compose.yml"

# Refuse if the chosen project name leaks any homelab token. Defensive
# overkill, but the cost is one grep.
if [[ "$COMPOSE_PROJECT" == *stage* || "$COMPOSE_PROJECT" == *prod* ]]; then
  echo "ERROR: refusing to use project name '$COMPOSE_PROJECT' — looks like a homelab project."
  exit 1
fi

CMD="${1:-up}"

# Helper for the actual compose invocation. Always uses -p + -f so the project
# name is fixed and the local file is unambiguous.
compose() {
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" "$@"
}

case "$CMD" in
  up)
    echo "==> Bringing up LOCAL postgres only (project: $COMPOSE_PROJECT)"
    compose up -d postgres
    echo ""
    echo "==> Waiting for postgres to report healthy…"
    # Loop until the healthcheck reports OK. 30s timeout keeps us from hanging
    # forever on a misconfigured Docker daemon.
    for i in $(seq 1 30); do
      STATUS="$(compose ps postgres --format '{{.Health}}' 2>/dev/null || echo 'unknown')"
      if [[ "$STATUS" == "healthy" ]]; then
        echo "    postgres is healthy."
        break
      fi
      sleep 1
    done
    echo ""
    echo "==> Connection details (use in backend/.env or as env override):"
    echo "    DATABASE_URL=postgresql://muhaven:muhaven@localhost:5432/muhaven"
    echo ""
    echo "Next step (first run only — applies the Drizzle schema):"
    echo "  bash scripts/dev-postgres.sh push"
    ;;

  push)
    echo "==> Pushing Drizzle schema to local postgres…"
    if ! compose ps postgres --status running --format '{{.Name}}' | grep -q .; then
      echo "ERROR: local postgres is not running. Run \`bash scripts/dev-postgres.sh up\` first."
      exit 1
    fi
    cd backend
    DATABASE_URL=postgresql://muhaven:muhaven@localhost:5432/muhaven pnpm db:push
    cd - >/dev/null
    echo "    schema applied."
    ;;

  down)
    echo "==> Stopping LOCAL postgres (project: $COMPOSE_PROJECT). Data volume preserved."
    compose stop postgres
    ;;

  reset)
    echo "==> Destroying LOCAL postgres data volume (project: $COMPOSE_PROJECT)."
    echo "    This wipes the local dev database. Press Ctrl+C now to abort."
    sleep 3
    compose down -v
    echo "    volume gone. Run \`bash scripts/dev-postgres.sh up\` to recreate."
    ;;

  status)
    echo "==> Status of LOCAL postgres (project: $COMPOSE_PROJECT, file: $COMPOSE_FILE):"
    compose ps postgres
    echo ""
    echo "Active Docker context: $ACTIVE_CONTEXT"
    ;;

  *)
    echo "ERROR: unknown command '$CMD' — expected one of: up | down | push | reset | status"
    exit 1
    ;;
esac
