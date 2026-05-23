#!/usr/bin/env bash
#
# scripts/sql/option-d-c1-migration.sh
#
# Wave 5 Option D · Commit 1 — one-shot operator-driven migration that
# revokes every pre-D1 narrow-CallPolicy Scoped session and emits paired
# `ScopedSessionRevokedByPolicyMigration` audit rows.
#
# Run ONCE after Commit 1 lands and the broadened CallPolicy code is
# live on the target environment. Sequence:
#
#   1. pnpm run deploy:homelab          # prod  → master
#      pnpm run deploy:homelab:stage    # stage → develop / agenticwave
#
#   2. bash scripts/db-push-homelab.sh prod    # lands the new
#                                              # `scoped_session_revoked_by_policy_migration`
#                                              # enum value in the live DB
#
#   3. bash scripts/sql/option-d-c1-migration.sh prod
#
# The migration is idempotent — re-run on a clean DB is a 200 no-op
# with `revokedCount: 0`. Re-run after a partial failure retries any
# leftover audit emissions.
#
# Despite the `scripts/sql/` location (which the brief specified), this
# is NOT a raw SQL file — the migration runs server-side through
# `RevokeAllPreOptionDScopedSessionsUseCase` so audit emission stays on
# the centralised WORM path. The shell script is just a thin
# curl-wrapper with branch-guard + secret read.
#
# Required env (on the operator's local machine, NOT in the repo):
#   OPTION_D_C1_MIGRATION_SECRET=...  # also set on the homelab as a
#                                      # backend env var; must match
#                                      # byte-for-byte
#
# Safety posture:
#   - Branch-guarded (prod → master, stage → develop) so a stale
#     working tree can't migrate prod against the wrong code revision.
#     Override with FORCE_BRANCH=1 for one-off operator interventions.
#   - Refuses to run when OPTION_D_C1_MIGRATION_SECRET is unset or
#     obviously too short — the backend would 503 anyway, but failing
#     locally produces a clearer error.
#   - `curl --fail` so a non-2xx response trips a non-zero exit.

set -euo pipefail

ENV_ARG="${1:-}"
if [[ "$ENV_ARG" != "prod" && "$ENV_ARG" != "stage" ]]; then
  cat >&2 <<'USAGE'
Usage: bash scripts/sql/option-d-c1-migration.sh {prod|stage}

  prod  → https://api.muhaven.app, master branch guard
  stage → https://api-stage.muhaven.app, develop branch guard

Required env:
  OPTION_D_C1_MIGRATION_SECRET   # shared secret (also set on homelab)

Optional env:
  FORCE_BRANCH=1                 # bypass branch guard for one-offs
  REASON="..."                   # custom audit metadata reason
USAGE
  exit 1
fi

if [[ "$ENV_ARG" == "prod" ]]; then
  API_BASE="https://api.muhaven.app"
  EXPECTED_BRANCH="master"
else
  API_BASE="https://api-stage.muhaven.app"
  # Stage tracks the active Wave 4/5 development branch. MUST equal
  # `db-push-homelab.sh::EXPECTED_BRANCH` + `deploy-homelab.sh::EXPECTED_BRANCH`
  # (both `agenticwave` today). Rotate the three together when stage's
  # active branch changes (see development/STAGING.md).
  # CR-HIGH-1 + BA-HIGH-1 (multi-agent review 2026-05-23) caught a
  # `develop` typo here that would have blocked every stage run with
  # an opaque guard mismatch.
  EXPECTED_BRANCH="agenticwave"
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
if [[ -z "$CURRENT_BRANCH" ]]; then
  echo "ERROR: not in a git checkout. Run from the repo root." >&2
  exit 1
fi
if [[ "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" && "${FORCE_BRANCH:-0}" != "1" ]]; then
  echo "ERROR: $ENV_ARG migration requires branch '$EXPECTED_BRANCH', currently on '$CURRENT_BRANCH'." >&2
  echo "  override with FORCE_BRANCH=1 bash scripts/sql/option-d-c1-migration.sh $ENV_ARG" >&2
  exit 1
fi

if [[ -z "${OPTION_D_C1_MIGRATION_SECRET:-}" ]]; then
  echo "ERROR: OPTION_D_C1_MIGRATION_SECRET is not set in the local env." >&2
  echo "  Read the value from the homelab .env (or 1Password vault MuHaven > Option D C1)." >&2
  exit 1
fi
if [[ ${#OPTION_D_C1_MIGRATION_SECRET} -lt 16 ]]; then
  echo "ERROR: OPTION_D_C1_MIGRATION_SECRET appears too short (< 16 chars)." >&2
  echo "  Backend would 503 this request; refusing to send." >&2
  exit 1
fi

# Build optional body. Empty body posts {} (Zod-strict — extra fields
# rejected); a custom reason sets the audit-metadata field.
#
# SecEng-HIGH-2 (multi-agent review 2026-05-23) — operator-supplied
# `$REASON` lands verbatim in the WORM audit row's `metadata.reason`
# field. Naïve double-quote escaping breaks on backslashes, newlines,
# control chars, and Unicode bidi marks (CVE-2021-42574 spoofing).
# Defense-in-depth: (1) client-side charset allowlist matches the
# server-side Zod regex byte-for-byte so malformed input fails fast
# on the operator's terminal, (2) JSON body built via `jq -n --arg`
# (or a strict allowlist-only fallback) so a stray quote can't break
# the JSON parser AND so curl can't be tricked into treating the
# value as a flag (e.g. `REASON='-K /etc/passwd'`).
BODY='{}'
if [[ -n "${REASON:-}" ]]; then
  if ! [[ "$REASON" =~ ^[A-Za-z0-9_.:/[:space:]-]{1,128}$ ]]; then
    cat >&2 <<'BAD_REASON'
ERROR: REASON contains disallowed characters. Allowed shape:
       ^[A-Za-z0-9_.:/[:space:]-]{1,128}$
       (matches the server-side Zod regex; defends the WORM audit
       row from injection-style payloads.)
BAD_REASON
    exit 1
  fi
  if command -v jq >/dev/null 2>&1; then
    BODY=$(jq -nc --arg reason "$REASON" '{reason: $reason}')
  else
    # `jq` is not installed — the allowlist regex above already
    # rejects every character that could break the bare-string
    # JSON we build here (no `"`, no `\`, no control chars).
    BODY="{\"reason\":\"${REASON}\"}"
  fi
fi

URL="${API_BASE}/api/v1/operator/option-d-c1-revoke-all-active-scoped-sessions"

echo "==> Option D · C1 migration"
echo "    env:    $ENV_ARG"
echo "    branch: $CURRENT_BRANCH (expected: $EXPECTED_BRANCH)"
echo "    url:    $URL"
echo "    body:   $BODY"
echo

# `curl --fail` exits non-zero on 4xx/5xx so the script bubbles the
# failure up. `--show-error` prints the failure body even with
# `--silent`. `--max-time` caps a runaway request; 60s is comfortably
# above the expected sub-second migration time, generous for a DB
# under load.
RESPONSE=$(curl \
  --silent \
  --show-error \
  --fail \
  --max-time 60 \
  --request POST \
  --header "Content-Type: application/json" \
  --header "Authorization: Bearer ${OPTION_D_C1_MIGRATION_SECRET}" \
  --data "${BODY}" \
  "${URL}")

# Pretty-print the response if `jq` is present; otherwise dump raw.
if command -v jq >/dev/null 2>&1; then
  echo "$RESPONSE" | jq .
else
  echo "$RESPONSE"
fi

echo
echo "==> Migration complete. Audit rows emitted; check Compliance dashboard or"
echo "    \`agent_audit_events\` for event_type = 'scoped_session_revoked_by_policy_migration'."
