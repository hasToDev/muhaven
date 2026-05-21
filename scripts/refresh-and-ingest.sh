#!/usr/bin/env bash
# refresh-and-ingest.sh -- Wave 5 Q2 -- operator-machine 8h cron entrypoint.
#
# Two phases:
#   1. `npm run refresh:all`            -- scrape rwa.xyz into data/*.json
#   2. `tsx scripts/ingest-oracle.ts`   -- POST data/*.json to prod backend
#
# Pre-flight: `GET ${ORACLE_INGEST_URL}/health` aborts before the 30-minute
# scrape if the backend is unreachable. Saves a full window.
#
# On non-zero exit of either phase (or a partial-success scrape -- some
# assets failed while `refresh:all` itself exited 0), fires a Telegram alert
# via the backend's /api/v1/operator/alert-test endpoint (same transport
# Q3 step 3 uses for yield-cron failures). The wrapper then propagates the
# phase exit code. The history log records whether the alert actually
# delivered (`notify=ok|fail`) so a follow-up monitor can detect "the
# alert path itself broke".
#
# Liveness: on the all-phases-OK path, once per UTC day the first
# successful run posts a heartbeat to the same alert-test channel
# (`Q2 daily heartbeat OK date=...`). Marker file at
# `${ORACLE_DIR}/_debug/.last-heartbeat-date` gates subsequent same-day
# runs to silent. Absence of a heartbeat for >24h IS the "cron never
# fired" signal -- replaces the prior reliance on the 28h
# staleness-check backstop for that failure mode.
#
# Per-run logs land in `_debug/cron-runs/<UTC-ISO>-<pid>.log`. A one-line
# outcome is appended to `_debug/refresh-history.log` so the operator can
# grep one place for "did the last 7 days of runs all succeed?".
#
# Config (env file, gitignored):
#   Default location: `scripts/refresh-and-ingest.env` (next to this script)
#   Override:         export MUHAVEN_Q2_ENV_FILE=/path/to/file
#
#   Required:
#     ORACLE_INGEST_SERVICE_SECRET  -- backend secret (matches backend/.env)
#     OPERATOR_ALERT_TEST_SECRET    -- alert endpoint secret (matches backend/.env)
#   Optional:
#     ORACLE_INGEST_URL             -- default: https://api.muhaven.app
#     OPERATOR_ALERT_URL            -- default: https://api.muhaven.app (pinned
#                                      to prod even if ORACLE_INGEST_URL is
#                                      pointed at staging for testing -- the
#                                      operator alert path is the load-bearing
#                                      signal and must reach the live channel)
#     LOG_RETENTION_RUNS            -- default: 30  (per-run logs to keep)
#
# Paths assumed:
#   $REPO_ROOT/scripts/refresh-and-ingest.sh           (this script)
#   $REPO_ROOT/scripts/oracle-mine/                    (scrape pipeline; committed
#                                                      scripts, gitignored
#                                                      .chrome-profile/ data/
#                                                      _debug/ node_modules/)
#   $REPO_ROOT/backend/scripts/ingest-oracle.ts        (ingest client)
#
# Cron host: the homelab (GUI Ubuntu 24.04 with autologin). Install via
# scripts/linux/install-oracle-refresh.sh (systemd --user timer).
# scripts/windows/install-oracle-refresh-task.ps1 is a fallback for the
# operator dev box; the homelab is the canonical host.
#
# Exit codes:
#   0   -- both phases succeeded (possibly with partial scrape; check history)
#   78  -- config error (missing env file / required vars / missing ORACLE_DIR
#          / unwritable log dir / placeholder secrets)
#   1   -- pre-flight failed (backend /health didn't return 200)
#   *   -- propagated from the failing phase (refresh:all or ingest-oracle.ts)
#
# Install as a Windows Task Scheduler entry via
# `scripts/windows/install-oracle-refresh-task.ps1`.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ORACLE_DIR="${SCRIPT_DIR}/oracle-mine"
ENV_FILE="${MUHAVEN_Q2_ENV_FILE:-${SCRIPT_DIR}/refresh-and-ingest.env}"

if [ ! -d "${ORACLE_DIR}" ]; then
  printf 'ERROR: ORACLE_DIR not found at %s\n' "${ORACLE_DIR}" >&2
  printf '       (scripts/oracle-mine/ is committed; if absent, repo is incomplete)\n' >&2
  exit 78
fi

if [ ! -d "${ORACLE_DIR}/node_modules" ]; then
  # The scraper deps (playwright + tsx + chromium binary) are NOT committed
  # and NOT shipped by deploy-homelab.sh -- the operator must `npm install`
  # once after the first sync to fetch ~150MB of Chromium.
  printf 'ERROR: %s/node_modules not found\n' "${ORACLE_DIR}" >&2
  printf '       Run: cd %s && npm install\n' "${ORACLE_DIR}" >&2
  printf '       (one-off bootstrap; downloads playwright + Chromium ~150MB)\n' >&2
  exit 78
fi

if [ ! -d "${ORACLE_DIR}/.chrome-profile" ]; then
  # The persistent Chromium profile holds the rwa.xyz session cookie. No
  # profile = no auth = the sanity probe will 401 every scrape.
  printf 'ERROR: %s/.chrome-profile not found\n' "${ORACLE_DIR}" >&2
  printf '       Run (with a display): DISPLAY=:0 npx tsx %s/scripts/scrape-asset.ts --slug=USYC\n' "${ORACLE_DIR}" >&2
  printf '       Log into rwa.xyz in the browser window, then press Enter to save the profile.\n' >&2
  exit 78
fi

LOG_DIR="${ORACLE_DIR}/_debug/cron-runs"
HISTORY_LOG="${ORACLE_DIR}/_debug/refresh-history.log"

# Timestamp + PID suffix avoids collisions when a manual `Start-ScheduledTask`
# fires inside the same second as a Task Scheduler tick (MultipleInstances=
# IgnoreNew only blocks the scheduled half).
TIMESTAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)-$$"
mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/${TIMESTAMP}.log"

# Pre-touch the log file. If the dir is unwritable (disk full, permission
# drift, antivirus quarantine) we fail loud and early instead of silently
# losing every `log()` call to /dev/null while phases still report "OK".
if ! : >> "${LOG_FILE}"; then
  printf 'ERROR: cannot write to log file %s\n' "${LOG_FILE}" >&2
  exit 78
fi

# Set by fire_alert; "" means no alert was attempted (so the run was clean).
NOTIFY_OUTCOME=""

# ---- helpers -----------------------------------------------------------------

log() {
  # Emit each line independently to stdout AND the log file. Both writes
  # are best-effort: under disk-full or pipe-closed, neither blocks the
  # other. This is more robust than `... | tee -a "${LOG_FILE}" || true`
  # which loses both targets if the upstream pipe breaks.
  local msg
  msg="[${TIMESTAMP}] $*"
  printf '%s\n' "${msg}" || true
  printf '%s\n' "${msg}" >> "${LOG_FILE}" 2>/dev/null || true
}

append_history() {
  # Outcome strings:
  #   ok                  -- both phases green; no alert attempted
  #   scrape-fail         -- phase 1 non-zero exit; alert fired
  #   scrape-partial      -- phase 1 exit 0 but refresh-all summary lists
  #                          some assets in `failed=...`; alert fired but
  #                          wrapper continues to ingest the fresh subset
  #   ingest-fail         -- phase 2 non-zero exit; alert fired
  #   preflight-fail      -- backend /health didn't return 200; no scrape
  #   config-fail         -- env-file / required-var / placeholder issue
  #
  # `notify=ok|fail` field is added whenever fire_alert was called. Grep
  # `notify=fail` to surface "the alert path itself broke" runs.
  local outcome="$1"
  local rc="$2"
  local notify_field=""
  if [ -n "${NOTIFY_OUTCOME}" ]; then
    notify_field=" notify=${NOTIFY_OUTCOME}"
  fi
  printf '[%s] outcome=%s rc=%d%s log=%s\n' \
    "${TIMESTAMP}" "${outcome}" "${rc}" "${notify_field}" "${LOG_FILE}" \
    >> "${HISTORY_LOG}" 2>/dev/null || true
}

prune_logs() {
  # Keep the most recent ${RETENTION} per-run logs.
  #
  # `head -n N` (positive integer) is POSIX. We avoid the GNU-only
  # `head -n -N` ("all but the last N") which silently no-ops elsewhere.
  # `count` is guarded against empty / non-numeric: a transient `ls`
  # failure (antivirus lock on Windows) under -e would otherwise abort
  # the script via `[ "" -gt 30 ]` integer-expression error AFTER both
  # phases already reported success -- masking a green run with a
  # non-zero exit and no alert.
  local count
  count="$(ls -1 "${LOG_DIR}" 2>/dev/null | wc -l | tr -d ' ' || true)"
  case "${count}" in
    ''|*[!0-9]*) count=0 ;;
  esac
  if [ "${count}" -gt "${RETENTION}" ]; then
    local skip=$((count - RETENTION))
    ls -1tr "${LOG_DIR}" 2>/dev/null \
      | head -n "${skip}" \
      | while IFS= read -r f; do
          [ -n "${f}" ] && rm -f -- "${LOG_DIR}/${f}"
        done
  fi
}

clean_stale_chromium_lock() {
  # Headed Chromium leaves a SingletonLock in `.chrome-profile/` while
  # it owns the profile. If the prior Task Scheduler tick was force-
  # killed (ExecutionTimeLimit fired) or the operator closed the bash
  # window mid-run, the orphan playwright/chrome process tree often
  # survives on Windows and keeps holding the lock until manually
  # killed -- blocking the next tick with a cryptic launch failure.
  #
  # Defensive sweep: if the lock is older than the 1h Task Scheduler
  # execution limit, the prior owner is almost certainly dead. Healthy
  # headed scrapes complete in well under 1h.
  local lock="${ORACLE_DIR}/.chrome-profile/SingletonLock"
  if [ -e "${lock}" ] || [ -L "${lock}" ]; then
    if find "${lock}" -mmin +60 2>/dev/null | grep -q .; then
      log "removing stale Chromium SingletonLock (mtime >1h)"
      rm -f -- "${lock}"
    fi
  fi
}

fire_alert() {
  # On non-zero exit (or partial-scrape), fire a synthetic alert through
  # the backend's alert-test endpoint so the operator gets a Telegram
  # ping. The 120-char cap below matches AlertTestDtoSchema.note's
  # `.max(120)` constraint at backend/api/v1/operator/alert-test.ts:52.
  local phase="$1"
  local rc="$2"

  # Sanitise hostname to charset safe for JSON-as-shell-string AND for
  # downstream log scrapers. Cap at 32 chars so the assembled note stays
  # under the 120 budget no matter what the timestamp / phase length is.
  local host
  host="$(hostname 2>/dev/null | tr -cd 'A-Za-z0-9._-' | cut -c1-32 || true)"
  [ -z "${host}" ] && host="unknown"

  local note="Q2 refresh-and-ingest failed: phase=${phase} exit=${rc} ts=${TIMESTAMP} host=${host}"
  local body='{"note":"'"${note}"'"}'

  log "firing operator alert (phase=${phase} exit=${rc})"

  # Bearer goes via stdin (`-H @-`) so it never appears in curl's argv.
  # On Windows, every process running as the operator's user can read
  # other processes' argv via Get-CimInstance Win32_Process -- argv is
  # the canonical leak vector. The pipe handle itself is anonymous on
  # the Cygwin layer (Git Bash) -- no `/proc/$pid/fd/0` equivalent on
  # Windows, so the secret really does stay scoped to curl's stdin.
  # Note: LF (`\n`) is correct here; do NOT "fix" to `\r\n` -- curl
  # synthesises the HTTP line terminators itself and a literal CR in
  # the header value will be sent verbatim, breaking auth.
  local curl_err_file="${LOG_FILE}.curl-err"
  local http
  http="$(printf 'Authorization: Bearer %s\n' "${OPERATOR_ALERT_TEST_SECRET}" \
    | curl -sS -m 30 -o /dev/null -w '%{http_code}' \
        -X POST "${OPERATOR_ALERT_URL}/api/v1/operator/alert-test" \
        -H @- \
        -H 'Content-Type: application/json' \
        --data "${body}" \
        2>"${curl_err_file}")" || http="curl-failed"

  log "alert-test response: HTTP ${http}"
  case "${http}" in
    2[0-9][0-9])
      NOTIFY_OUTCOME="ok"
      ;;
    *)
      NOTIFY_OUTCOME="fail"
      # Surface the captured curl stderr on failure so the operator can
      # distinguish DNS/TLS/proxy issues at a glance.
      if [ -s "${curl_err_file}" ]; then
        log "curl stderr:"
        while IFS= read -r line; do log "  ${line}"; done < "${curl_err_file}"
      fi
      ;;
  esac
  rm -f -- "${curl_err_file}"
}

check_partial_scrape() {
  # refresh-all.ts writes a per-asset summary to refresh-history.log on
  # exit (see scripts/oracle-mine/scripts/refresh-all.ts appendHistory)
  # of the form:
  #
  #   [2026-05-21T02:48:07.000Z] 8/11 ok failed=USYC,BUIDL,EUTBL
  #
  # The script exits 0 even when some assets failed -- by design, so
  # the working subset still gets persisted. But that silent partial
  # state would otherwise let the wrapper happily ingest stale data
  # for the failed assets while reporting green.
  #
  # We grep the LAST refresh-all summary line (its dotted-millisecond
  # timestamp shape distinguishes it from our own outcome line which
  # uses dashed seconds + PID). If it carries `failed=`, alert and
  # tag history `scrape-partial`. We do NOT abort -- the fresh subset
  # is still worth ingesting; the stale failed assets surface again
  # via the homelab `oracle-staleness-check.sh` 28h backstop.
  local last_summary
  last_summary="$(grep -E '^\[[0-9T:.Z-]+\] [0-9]+/[0-9]+ ok' "${HISTORY_LOG}" 2>/dev/null | tail -1 || true)"
  if [ -n "${last_summary}" ] && [[ "${last_summary}" == *"failed="* ]]; then
    local failed
    failed="$(printf '%s' "${last_summary}" | sed -n 's/.*failed=\([^[:space:]]*\).*/\1/p')"
    log "Phase 1 PARTIAL: refresh-all reports failed=${failed}"
    fire_alert "scrape-partial" 0
    append_history "scrape-partial" 0
    return 0
  fi
  return 1
}

fire_heartbeat() {
  # Once-per-UTC-day "Q2 is alive" Telegram ping, gated on a marker file
  # to keep the noise floor low. Closes the silent-dead-cron observability
  # gap (round-2 DevOps H-2): without a heartbeat, "scheduled task never
  # fires at all" is invisible until the 28h staleness-check backstop
  # alerts at NAV expiry. With a daily heartbeat the absence of a ping
  # for >24h IS the signal.
  #
  # Semantics: fires ONLY on the all-phases-OK path. Partial-scrape /
  # ingest-fail / preflight-fail / config-fail already fire their own
  # alerts via fire_alert -- adding a heartbeat there would dilute the
  # "absence-as-signal" guarantee. The marker file is updated ONLY on
  # successful 2xx delivery, so a transient curl-fail retries the
  # heartbeat on the next OK tick instead of suppressing today's ping.
  local marker="${ORACLE_DIR}/_debug/.last-heartbeat-date"
  # _debug/ exists today as a side-effect of LOG_DIR creation (line ~74),
  # but make the dependency explicit so a future refactor that moves
  # LOG_DIR can't silently break the heartbeat (and thus the absence-of-
  # heartbeat "cron never fired" signal).
  mkdir -p "$(dirname "${marker}")" 2>/dev/null || true

  local today_utc
  today_utc="$(date -u +%Y-%m-%d)"

  local last=""
  if [ -f "${marker}" ]; then
    last="$(head -n1 "${marker}" 2>/dev/null | tr -d '[:space:]' || true)"
    # Defensive parse: whitelist ISO-date shape so a BOM, hand-edit,
    # garbage write, or wrong-charset content can't pin the heartbeat
    # to a phantom date forever. If the marker is malformed, treat as
    # never-set and re-fire (harmless duplicate ping at worst).
    if ! [[ "${last}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
      log "heartbeat: marker content '${last}' is not YYYY-MM-DD; treating as unset"
      last=""
    fi
  fi

  if [ "${last}" = "${today_utc}" ]; then
    # Gated on MUHAVEN_Q2_DEBUG to keep the per-run log greppable for
    # real events; 3 ticks/day × OK days is 2 noise lines/day otherwise.
    [ "${MUHAVEN_Q2_DEBUG:-}" = "1" ] && log "heartbeat: already pinged for ${today_utc}; skip"
    return
  fi

  local host
  host="$(hostname 2>/dev/null | tr -cd 'A-Za-z0-9._-' | cut -c1-32 || true)"
  [ -z "${host}" ] && host="unknown"

  local note="Q2 daily heartbeat OK date=${today_utc} host=${host}"
  # 120-char cap matches AlertTestDtoSchema.note.max(120). With the prefix
  # at 47 chars + max 32-char host this is belt-and-suspenders today, but
  # keep it so a future contributor extending the note text can't silently
  # blow the schema and get a 400 from the backend.
  note=${note:0:120}
  local body='{"note":"'"${note}"'"}'

  log "heartbeat: first OK run for ${today_utc}; pinging operator alert channel"

  local curl_err_file="${LOG_FILE}.heartbeat-curl-err"
  local http
  http="$(printf 'Authorization: Bearer %s\n' "${OPERATOR_ALERT_TEST_SECRET}" \
    | curl -sS -m 30 -o /dev/null -w '%{http_code}' \
        -X POST "${OPERATOR_ALERT_URL}/api/v1/operator/alert-test" \
        -H @- \
        -H 'Content-Type: application/json' \
        --data "${body}" \
        2>"${curl_err_file}")" || http="curl-failed"

  log "heartbeat response: HTTP ${http}"
  case "${http}" in
    2[0-9][0-9])
      # Atomic-ish update: write to temp + mv so a kill mid-write doesn't
      # leave a half-truncated marker that confuses the next run's
      # comparison. A stale .tmp from a SIGKILL between printf and mv is
      # self-healing: the regex-validate above treats malformed content
      # as unset, and the NEXT successful 2xx's `mv -f` clobbers the
      # orphan. No dual-ping risk; at worst one extra heartbeat the day
      # after the kill.
      if ! { printf '%s\n' "${today_utc}" > "${marker}.tmp" 2>/dev/null \
        && mv -f -- "${marker}.tmp" "${marker}" 2>/dev/null; }; then
        log "heartbeat: failed to update marker ${marker}"
        # Clean up the orphan tmp if printf wrote anything before failing
        # (avoids accumulating .tmp files on disk-full conditions).
        rm -f -- "${marker}.tmp" 2>/dev/null || true
      fi
      ;;
    *)
      if [ -s "${curl_err_file}" ]; then
        log "heartbeat curl stderr:"
        while IFS= read -r line; do log "  ${line}"; done < "${curl_err_file}"
      fi
      # NB: marker NOT updated -- next OK run will retry the heartbeat.
      ;;
  esac
  rm -f -- "${curl_err_file}"
}

# ---- config ------------------------------------------------------------------

log "Starting refresh-and-ingest"
log "repo=${REPO_ROOT}"
log "env-file=${ENV_FILE}"

if [ ! -f "${ENV_FILE}" ]; then
  log "ERROR: env file not found at ${ENV_FILE}"
  log "       copy scripts/refresh-and-ingest.env.example and fill in the secrets"
  append_history "config-fail" 78
  exit 78
fi

# Source as shell-locals (NO `set -a`). Critical: with auto-export on,
# `ORACLE_INGEST_SERVICE_SECRET` + `OPERATOR_ALERT_TEST_SECRET` would land
# in the env of `npm run refresh:all` -- where 100s of transitive npm
# packages could read process.env. We pass the ingest secret to the
# ingest phase explicitly below; the alert secret stays in this shell
# and `fire_alert` accesses it via shell-function closure.
#
# Caveat: a hand-edited env file that uses `export VAR=...` instead of
# bare assignment still exports despite the absence of `set +a` here.
# The .env.example uses bare assignments to dodge this; document in
# the README that operators must NOT prefix lines with `export`.
# shellcheck disable=SC1090
. "${ENV_FILE}"

missing=0
for var in ORACLE_INGEST_SERVICE_SECRET OPERATOR_ALERT_TEST_SECRET; do
  if [ -z "${!var:-}" ]; then
    log "ERROR: required var ${var} is unset in ${ENV_FILE}"
    missing=1
  fi
done
if [ "${missing}" -eq 1 ]; then
  append_history "config-fail" 78
  exit 78
fi

# Reject the placeholder verbatim -- a partial copy of the .example file
# that leaves `<<FILL>>` in would otherwise sail past the empty-string
# check and silently 401 from the backend (drowning the alert path too).
for var in ORACLE_INGEST_SERVICE_SECRET OPERATOR_ALERT_TEST_SECRET; do
  if [ "${!var}" = "<<FILL>>" ]; then
    log "ERROR: ${var} still set to the placeholder '<<FILL>>' in ${ENV_FILE}"
    append_history "config-fail" 78
    exit 78
  fi
done

ORACLE_INGEST_URL="${ORACLE_INGEST_URL:-https://api.muhaven.app}"
# Pin alert URL to prod independently: operator may point ingest at
# stage for one-off testing, but the alert channel must always reach
# the live operator Telegram. Stage Telegram is intentionally OFFLINE
# per project_wave5_cutover_complete; silent alerts there would be the
# worst-of-both-worlds outcome.
OPERATOR_ALERT_URL="${OPERATOR_ALERT_URL:-https://api.muhaven.app}"

# Validate retention up-front. Default to 30 on bad input. Otherwise
# `head -n "${skip}"` with skip=$((count - "thirty")) errors out.
RETENTION="${LOG_RETENTION_RUNS:-30}"
case "${RETENTION}" in
  ''|*[!0-9]*) log "warning: LOG_RETENTION_RUNS='${RETENTION}' non-numeric; defaulting to 30"; RETENTION=30 ;;
esac

# ---- pre-flight --------------------------------------------------------------

# Cheap reachability check before the 30-min Chromium scrape. A DNS / TLS
# / 5xx blip here is much better caught now than after we've burned a
# full scrape window on data we can't deliver. The /health route is
# unauthenticated -- no secret leaks here.
log "Pre-flight: ${ORACLE_INGEST_URL}/health"
# Capture stdout (HTTP code) and exit code separately. `|| echo curl-failed`
# inside the $() would concatenate the failure marker AFTER curl's "000"
# fallback for unreachable hosts -- producing "000curl-failed" which is
# noisier than useful.
preflight_http="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "${ORACLE_INGEST_URL}/health" 2>/dev/null)" || preflight_http="curl-failed"
case "${preflight_http}" in
  200)
    log "Pre-flight OK (HTTP 200)"
    ;;
  *)
    log "Pre-flight FAILED: ${ORACLE_INGEST_URL}/health returned ${preflight_http}"
    fire_alert "preflight" 1
    append_history "preflight-fail" 1
    prune_logs
    exit 1
    ;;
esac

# Defensive: sweep a stale Chromium profile lock before launching playwright.
clean_stale_chromium_lock

# ---- phase 1: scrape ---------------------------------------------------------

log "=== Phase 1: npm run refresh:all (${ORACLE_DIR}) ==="
refresh_rc=0
# Subshell preserves -e for the rest of the script while letting the
# guarded command capture its own exit code. The scrape phase gets a CLEAN
# env -- secrets are shell-locals, not exported, so they don't leak into
# the npm process tree.
(cd "${ORACLE_DIR}" && npm run refresh:all) >> "${LOG_FILE}" 2>&1 || refresh_rc=$?

if [ "${refresh_rc}" -ne 0 ]; then
  log "Phase 1 FAILED (refresh:all exit=${refresh_rc})"
  fire_alert "scrape" "${refresh_rc}"
  append_history "scrape-fail" "${refresh_rc}"
  prune_logs
  exit "${refresh_rc}"
fi

# Partial-success detection: refresh-all exits 0 even when some assets
# failed. Surface that so we don't ingest stale data silently.
check_partial_scrape || true
log "Phase 1 OK"

# ---- phase 2: ingest ---------------------------------------------------------

log "=== Phase 2: ingest-oracle.ts (${REPO_ROOT}/backend) ==="
ingest_rc=0
# Two execution modes -- chosen by whether the backend's npm deps live
# on this host:
#   - Dev box (Windows / standalone Linux dev env): operator ran
#     `pnpm install` in backend/ so tsx is on disk. Run directly with
#     the data dir at scripts/oracle-mine/data.
#   - Homelab: backend runs inside docker; node_modules lives only
#     inside the container image. Run via `docker compose exec` with
#     ORACLE_DATA_DIR pointing at /oracle-mine-data (volume mount in
#     docker-compose.yml, host side scripts/oracle-mine/data).
# Inline-prefix env vars (dev) / -e flags (docker) so they're scoped
# to the subprocess only -- no `export` reaches subsequent commands.
if [ -x "${REPO_ROOT}/backend/node_modules/.bin/tsx" ]; then
  log "  (running ingest locally: backend/node_modules/.bin/tsx)"
  (cd "${REPO_ROOT}/backend" && \
     ORACLE_INGEST_URL="${ORACLE_INGEST_URL}" \
     ORACLE_INGEST_SERVICE_SECRET="${ORACLE_INGEST_SERVICE_SECRET}" \
     ORACLE_DATA_DIR="${ORACLE_DIR}/data" \
     ./node_modules/.bin/tsx scripts/ingest-oracle.ts) \
    >> "${LOG_FILE}" 2>&1 || ingest_rc=$?
else
  log "  (running ingest via docker compose exec backend)"
  (cd "${REPO_ROOT}" && \
     docker compose -f docker-compose.yml -p muhaven exec -T \
       -e ORACLE_INGEST_URL="${ORACLE_INGEST_URL}" \
       -e ORACLE_INGEST_SERVICE_SECRET="${ORACLE_INGEST_SERVICE_SECRET}" \
       -e ORACLE_DATA_DIR=/oracle-mine-data \
       backend node_modules/.bin/tsx scripts/ingest-oracle.ts) \
    >> "${LOG_FILE}" 2>&1 || ingest_rc=$?
fi

# Defence-in-depth: the ingest secret is no longer needed in this shell.
# Drop it from the environment so any subsequent process spawned by the
# wrapper (currently none, but hardens against future drift) can't see it.
unset ORACLE_INGEST_SERVICE_SECRET

if [ "${ingest_rc}" -ne 0 ]; then
  log "Phase 2 FAILED (ingest-oracle.ts exit=${ingest_rc})"
  fire_alert "ingest" "${ingest_rc}"
  append_history "ingest-fail" "${ingest_rc}"
  prune_logs
  exit "${ingest_rc}"
fi
log "Phase 2 OK"

# ---- done --------------------------------------------------------------------

log "All phases OK"
append_history "ok" 0
fire_heartbeat
prune_logs
exit 0
