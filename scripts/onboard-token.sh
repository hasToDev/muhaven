#!/usr/bin/env bash
# scripts/onboard-token.sh
#
# Bash wrapper around scripts/onboard-token.ts. Sources the matching
# preset from scripts/env/<symbol>.env (sets MUHAVEN_TOKEN_NAME +
# MUHAVEN_NAV_INITIAL + the rest), then dispatches to the right
# environment via pnpm.
#
# Run this script (do NOT `source` it — it uses `set -e` and would
# kill an interactive shell on any failure):
#
#   bash scripts/onboard-token.sh <symbol> [prod|stage]
#
# Examples:
#   bash scripts/onboard-token.sh tbill1                # prod  (default env)
#   bash scripts/onboard-token.sh gold1                 # prod
#   bash scripts/onboard-token.sh tbill1 stage          # staging
#   bash scripts/onboard-token.sh gold1  stage          # staging
#
# After both tokens onboard cleanly:
#   - deployments/arb-sepolia-v2[.staging].json gains a populated
#     `tokens: { TBILL1: {…}, GOLD1: {…} }` section.
#   - Fill the per-token JSON arrays in backend/.env (REDEMPTION_QUEUE_*,
#     YIELD_SNAPSHOT_*, MUHAVEN_TOKEN_ADDRESSES_JSON, TREASURY_*) and
#     the per-token JSON maps in frontend/.env (VITE_TREASURIES_JSON,
#     VITE_QUEUES_JSON, VITE_YIELD_SNAPSHOTS_JSON). Map keys MUST be
#     lowercase per frontend/src/contracts/addresses.ts.

set -euo pipefail

# ── Parse args ────────────────────────────────────────────────────────────────

if [[ $# -lt 1 ]]; then
  echo "ERROR: missing token symbol." >&2
  echo "" >&2
  echo "Usage: bash scripts/onboard-token.sh <symbol> [prod|stage]" >&2
  echo "Examples:" >&2
  echo "  bash scripts/onboard-token.sh tbill1" >&2
  echo "  bash scripts/onboard-token.sh gold1 prod" >&2
  echo "  bash scripts/onboard-token.sh tbill1 stage" >&2
  exit 1
fi

# Symbol arg is case-insensitive — operators often type SYMBOL upper-case.
SYMBOL_RAW="$1"
SYMBOL="$(printf '%s' "$SYMBOL_RAW" | tr '[:upper:]' '[:lower:]')"
ENV="${2:-prod}"

case "$ENV" in
  prod|stage) ;;
  *)
    echo "ERROR: unknown env '$ENV' — expected 'prod' or 'stage'." >&2
    exit 1
    ;;
esac

# ── Locate preset ─────────────────────────────────────────────────────────────

# Resolve the repo root from the script's own location so this works no
# matter where the operator invokes it from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ENV_FILE="${REPO_ROOT}/scripts/env/${SYMBOL}.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: preset not found: $ENV_FILE" >&2
  echo "" >&2
  echo "Available presets:" >&2
  for f in "${REPO_ROOT}/scripts/env"/*.env; do
    [[ -f "$f" ]] && echo "  $(basename "${f%.env}")" >&2
  done
  echo "" >&2
  echo "To add a new token, copy an existing preset and edit symbol/name/NAV." >&2
  exit 1
fi

# ── Run ───────────────────────────────────────────────────────────────────────

echo "==> Sourcing preset: scripts/env/${SYMBOL}.env"
# shellcheck source=/dev/null
source "$ENV_FILE"

# Sanity-print so the operator sees what's about to land on-chain.
echo "    MUHAVEN_TOKEN_SYMBOL    = ${MUHAVEN_TOKEN_SYMBOL:-<unset>}"
echo "    MUHAVEN_TOKEN_NAME      = ${MUHAVEN_TOKEN_NAME:-<unset>}"
echo "    MUHAVEN_NAV_INITIAL     = ${MUHAVEN_NAV_INITIAL:-<unset>}"
echo "    MUHAVEN_INSTANT_CAP     = ${MUHAVEN_INSTANT_CAP:-<unset>}"
echo "    MUHAVEN_MAX_DEVIATION_BPS = ${MUHAVEN_MAX_DEVIATION_BPS:-<unset>}"
echo "    MUHAVEN_ORACLE_KIND     = ${MUHAVEN_ORACLE_KIND:-<unset>}"

if [[ "$ENV" == "prod" ]]; then
  echo "==> Onboarding (PROD) — pnpm run onboard-token:testnet"
  cd "$REPO_ROOT"
  pnpm run onboard-token:testnet
else
  echo "==> Onboarding (STAGE) — pnpm run onboard-token:testnet:stage"
  cd "$REPO_ROOT"
  pnpm run onboard-token:testnet:stage
fi

echo ""
echo "Onboarding complete ($ENV / ${MUHAVEN_TOKEN_SYMBOL:-?})."
echo "Next: open deployments/arb-sepolia-v2$( [[ \"$ENV\" == 'stage' ]] && echo '.staging' ).json"
echo "      → tokens.${MUHAVEN_TOKEN_SYMBOL:-?}.contracts has the new addresses."
