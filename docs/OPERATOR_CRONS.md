# Operator Crons

MuHaven runs four scheduled tasks. All canonical hosts are on the homelab
(`192.168.1.52`, GUI Ubuntu 24.04 LTS with autologin). This file is the
central index — when one of them drifts, the runbook below tells you which
mechanism owns it, how it alerts, and where the per-cron notes live.

| Cron | Mechanism | Schedule | Failure detector | Escalation | Runbook |
|---|---|---|---|---|---|
| YieldDistributionCron | Backend docker container (node-cron) | Daily at `00:00 UTC` | Per-tick try/catch + `notifyYieldCronFailure` → Telegram | Immediate Telegram on phase failure; daily heartbeat (`YIELD_CRON_HEARTBEAT`, severity=info) at end of every tick with per-token sweep summary (2026-05-22 — replaced the pre-existing dry-run-gated boot-alert) | `backend/src/infrastructure/blockchain/yield-cron.ts` header; `development/DEV_WAVE_5/Q3_PLAN.md` |
| oracle-staleness-check.sh | Homelab host crontab (`*/30 * * * *`) | Every 30 min | Per-token `getNAV().updatedAt` age vs `THRESHOLD_HR` (default 28h) | Telegram alert per stale token; backstop for ALL upstream NAV pipelines | `scripts/oracle-staleness-check.sh` header; `development/DEV_WAVE_3/HOMELAB_DEPLOY.md` "Oracle staleness monitor" |
| nav-publisher | Dedicated docker service | Per-token internal scheduler; refreshes a token when its on-chain NAV age ≥ ½ of contract max-staleness | Container restart loop + structured logs | Surfaces as stale NAV at the 28h backstop above | `nav-publisher/src/publisher.ts`; `project_design_a_navwriter_pattern` memory |
| refresh-and-ingest (Wave 5 Q2) | systemd `--user` timer in autologin desktop session | `00:00 / 08:00 / 16:00 UTC` daily | Per-phase exit code + partial-scrape detection (`refresh-history.log` `failed=...` match) + `notify=fail` history flag when alert delivery itself broke + daily heartbeat ping (absence-of-heartbeat for >24h IS the "cron never fired" signal — operator-monitored today; an automated absence-detector is filed as a future enhancement) | Telegram via `/api/v1/operator/alert-test` (failures AND daily liveness); 28h backstop above | `scripts/refresh-and-ingest.sh` header; `scripts/oracle-mine/README.md` |

## Failure-detection topology

The four crons are layered, not independent:

```
fresh rwa.xyz data ──► (Q2 refresh-and-ingest, 8h, homelab)
                              │ writes oracle_snapshots
                              ▼
on-chain NAV  ──► (nav-publisher, per-token cadence, homelab)
                              │ calls IssuerControlledOracle.setNAV
                              ▼
                ┌─────────────────────────────┐
                │  Token's `getNAV().updatedAt`│ ◄── (oracle-staleness-check.sh, 30min poll, 28h alert)
                └─────────────────────────────┘
                              │
                              ▼
distributable yield ──► (YieldDistributionCron, daily 00 UTC, backend container)
```

If Q2 breaks → fresh data stops flowing in → nav-publisher re-stamps the
last-known NAV (synthetic-token fallback, see `project_design_a_navwriter_pattern`)
→ on-chain NAV stays fresh-looking for a while → staleness-check eventually
alerts at 28h IF nav-publisher ALSO drifts. Q2's own Telegram alert is the
8h-granularity signal on individual run failures; the daily heartbeat
catches "cron never even fired" within ~24h (absence-of-ping = signal);
the 28h staleness backstop is the final safety net.

## Operator install rituals

### Q2 refresh-and-ingest (homelab, one-time)

The Q2 cron runs in the operator's autologin desktop session on the
homelab. Headed Chromium needs `$DISPLAY` and a real session — running
it in a docker container or under SYSTEM would either deadlock or render
to an invisible session 0.

Bootstrap is operator-driven (one-time); after that, cron updates ride
the operator's `scripts/deploy-homelab.sh` step 5e — which rsyncs
`scripts/oracle-mine/`, the wrapper, the env template, and the Linux
installer. The `pnpm run deploy:homelab` step also handles the backend
container restart, which is required after `docker-compose.yml` volume
changes (the backend has a `./scripts/oracle-mine/data:/oracle-mine-data:ro`
read-only mount so the wrapper's `docker compose exec backend tsx
scripts/ingest-oracle.ts` flow can see the freshly scraped JSON).

> **Note:** `scripts/deploy-homelab.sh` is gitignored (operator-specific
> hostnames + SSH key paths). The step 5e block must include the Q2
> entries manually; reference the canonical block in the commit that
> landed Q2b (search `git log --all --diff-filter=A scripts/oracle-mine/`)
> if rebuilding from scratch.

```bash
ssh muhaven@192.168.1.52        # or open a terminal on the homelab GUI
cd ~/Project/Fhenix/MuHaven

# 1. Install the scrape pipeline's npm deps + Chromium (~150MB)
cd scripts/oracle-mine
npm install
cd -

# 2. Interactive Chromium login -- seeds .chrome-profile/ with the
#    rwa.xyz session cookie. Use the homelab's GUI, NOT SSH:
DISPLAY=:0 npx --prefix scripts/oracle-mine tsx scripts/oracle-mine/scripts/scrape-asset.ts --slug=USYC
# Browser window opens. Log into rwa.xyz. Then return to terminal + press Enter.

# 3. Populate secrets (gitignored target file)
cp scripts/refresh-and-ingest.env.example scripts/refresh-and-ingest.env
chmod 600 scripts/refresh-and-ingest.env
# Edit: paste ORACLE_INGEST_SERVICE_SECRET + OPERATOR_ALERT_TEST_SECRET from
#       backend/.env. Keep bare key=value form (NO `export`).

# 4. Manual smoke (3-5 min: headed Chromium scrape + ingest to prod backend)
bash scripts/refresh-and-ingest.sh
# Expected: outcome=ok rc=0 line at end of scripts/oracle-mine/_debug/refresh-history.log

# 5. Register the systemd --user timer
bash scripts/linux/install-oracle-refresh.sh
```

Verify / force-run / uninstall:

```bash
systemctl --user status muhaven-oracle-refresh.timer
systemctl --user list-timers muhaven-oracle-refresh.timer
systemctl --user start muhaven-oracle-refresh.service          # one-off
journalctl --user -u muhaven-oracle-refresh.service -f         # tail
bash scripts/linux/uninstall-oracle-refresh.sh                 # remove
```

### "No heartbeat for >24h" — investigation checklist

When the operator notices the daily `Q2 daily heartbeat OK date=...` ping
hasn't landed in Telegram for >24h, walk these in order:

1. `systemctl --user list-timers muhaven-oracle-refresh.timer` —
   is the timer armed? `NEXT` column non-empty?
2. `journalctl --user -u muhaven-oracle-refresh.service --since '36h ago'` —
   did the service fire? Any error in the output?
3. `tail -20 scripts/oracle-mine/_debug/refresh-history.log` —
   last few outcome lines. Are they `ok` / `scrape-partial` / `*-fail`?
4. `cat scripts/oracle-mine/_debug/.last-heartbeat-date` —
   what date does the marker think it last pinged? If today's UTC
   date, the wrapper THINKS it's healthy; the alert transport is the
   suspect. If yesterday's, the wrapper hasn't had an OK run today.
5. `loginctl show-user $USER | grep Linger` —
   if lingering is disabled and the autologin session dropped across
   00 / 08 / 16 UTC, the user systemd manager wasn't up to fire the
   timer. `sudo loginctl enable-linger $USER` closes the gap.

Programmatic "did today's heartbeat fire" check (useful for an external
monitor):
```bash
test "$(cat scripts/oracle-mine/_debug/.last-heartbeat-date 2>/dev/null)" = "$(date -u +%Y-%m-%d)"
```

To force-fire a same-day heartbeat (e.g. after recovering from alert-
endpoint downtime), delete the marker so the next OK tick re-pings:
```bash
rm -f scripts/oracle-mine/_debug/.last-heartbeat-date
systemctl --user start muhaven-oracle-refresh.service
```

If the operator user is not always sitting in a graphical session
(no autologin, or laptop-style sessions), enable lingering so the
user manager runs across logout:

```bash
sudo loginctl enable-linger "$USER"
```

### Q2 refresh-and-ingest (Windows dev box, FALLBACK only)

If for some reason the homelab is unavailable, a Windows Task Scheduler
installer at `scripts/windows/install-oracle-refresh-task.ps1` registers
the same wrapper. Note that the operator's dev box being off across all
three trigger windows means the day's data refresh is skipped entirely
— hence "fallback".

```bash
powershell.exe -ExecutionPolicy Bypass -File scripts/windows/install-oracle-refresh-task.ps1
powershell.exe -Command "Get-ScheduledTask -TaskName 'MuHaven\OracleRefresh' | Get-ScheduledTaskInfo"
powershell.exe -ExecutionPolicy Bypass -File scripts/windows/uninstall-oracle-refresh-task.ps1
```

### oracle-staleness-check.sh (homelab, one-time)

```bash
# Already deployed via scripts/deploy-homelab.sh step 5e on every backend deploy.
# Operator-installed crontab on the homelab:
#   */30 * * * * cd /home/muhaven/Project/Fhenix/MuHaven && \
#                bash scripts/oracle-staleness-check.sh \
#                >> /var/log/muhaven-oracle-monitor.log 2>&1
# Secrets live in /home/muhaven/Project/Fhenix/MuHaven/.monitor.env (chmod 600).
```

### YieldDistributionCron (backend container)

In-process, starts with the backend container. Toggled by env:

```
YIELD_CRON_ENABLED=true
YIELD_CRON_PRIVATE_KEY=<signer>
YIELD_CRON_DRY_RUN=true|false
YIELD_CRON_SNAPSHOT_FUNDING=true   # FU-1 (Wave 5 W2); default true
YIELD_CRON_MAX_SUPPLY_CAP=10000    # safety ceiling under snapshot funding
```

No registration step — `pnpm run deploy:homelab` brings it up with the backend.

**Shared issuer EOA / nonce collisions (FU-4):** the yield issuer EOA
(`YIELD_CRON_PRIVATE_KEY`) is shared with the nav crons on prod, so a
concurrent NAV tx can advance the account nonce and reject a yield tx with
`NONCE_EXPIRED` ("nonce too low"). The runner now absorbs this: it logs
`nonce collision on send … re-querying nonce + retrying` (warn) and retries
the send (backoff 500/1500/3000ms, up to 4 attempts) — a nonce-rejected tx
never executed, so re-sending is safe. Occasional retry warns at 00:00 UTC
are expected and benign. A run that still fails self-heals on the next tick's
resume. If collisions become frequent, the deeper fix is a dedicated yield EOA
(it must remain the on-chain `tokenRegistry.getConfig(token).issuer`) or
schedule separation from the nav cadence.

**Funding model (FU-1, Wave 5 W2):** with `YIELD_CRON_SNAPSHOT_FUNDING=true`
(default) the cron sizes each epoch to the ACTUAL snapshotted supply —
`min(decryptedSupply, YIELD_CRON_MAX_SUPPLY_CAP) × ratePerShare /
RATE_SCALE` — by decrypting the on-chain `YieldSnapshot.encTotalSupply`
post-finalize. The cap is now a SAFETY CEILING, not the funded amount. Set
`YIELD_CRON_SNAPSHOT_FUNDING=false` to roll back to legacy cap-based funding
(no per-tick decrypt). New operator alerts to watch:

| Alert | Severity | Meaning / action |
|---|---|---|
| `SnapshotSupplyDecryptError` (message: *"…Likely transient…"*) | error | A FRESH-finalize tick couldn't decrypt `encTotalSupply` — likely same-tick ACL-propagation lag; self-heals next tick (supply is immutable post-finalize). |
| `SnapshotSupplyDecryptError` (message: *"PERSISTENT … STALLED"*) | error | The epoch finalized on a PRIOR tick and STILL can't be decrypted → the ACL has had ≥1 full tick to propagate, so this is **structural** (un-indexable handle at that token's holder scale / coprocessor / RPC), NOT lag. Yield for the token is stalled. **Halt + roll back** (`YIELD_CRON_SNAPSHOT_FUNDING=false`) and investigate; do not wait it out. |
| `SnapshotSupplyExceedsCapError` | warn | Snapshot supply exceeded the cap → funded the ceiling, BELOW the claimable total, so late claimants silent-fail. **Raise `YIELD_CRON_MAX_SUPPLY_CAP`.** If it fires every tick, the on-chain supply is in a larger decimal scale than the cap envelope — verify before raising. |

**⚠️ Enable FU-1 safely — smoke ONE token BEFORE the first unattended midnight tick.**
The same-tick `encTotalSupply` decrypt is sound by construction but had no live
proof at implementation time, and the funded amount depends on the on-chain
supply's (unverified) decimal scale. Because the cron is **default-on**, the
00:00 UTC tick will fund automatically — so before deploying with snapshot
funding live, run the one-token smoke and confirm the magnitudes:

```
docker compose -f docker-compose.yml -p muhaven exec backend \
  pnpm tsx scripts/run-daily-yield.ts --snapshot-funding --token=USYC
```

Confirm the INFO log `snapshot funding: sized epoch to actual on-chain supply`
shows a real `decryptedSupply`, `clamped:false`, and a `computedYield` that
matches the proven cap-based epoch magnitude (~$0.093 for CETES). A
`clamped:true` (or a decrypt failure) means **do not enable yet** — the decimal
scale is off or the decrypt doesn't resolve. (`--cap-funding` forces the legacy
path. Avoid pairing the smoke with `--dry-run` against prod Postgres — it
historically stranded an `epoch_id=0` poison row that wedged the next live tick.
As of **FU-3** (2026-05-25) this is code-fixed two ways: dry-run swaps in a NoOp
audit writer so it never writes to prod Postgres, and the runner auto-resolves
any pre-existing stranded `epoch_id=0` row to `failure` on the next live tick —
look for the `FU-3: audit row references a non-existent on-chain epoch` log line.
Still prefer a live one-token smoke to a dry-run for funding validation.) If
you'd rather gate it, deploy with `YIELD_CRON_SNAPSHOT_FUNDING=false` first,
smoke, then flip to `true` and restart.

### nav-publisher (homelab)

Dedicated docker service in `docker-compose.yml`. Starts with the stack.

## Secret drift

Three locations hold operator secrets:

| Secret | Homelab `backend/.env` | Homelab `.monitor.env` | Homelab `scripts/refresh-and-ingest.env` |
|---|---|---|---|
| `ORACLE_INGEST_SERVICE_SECRET` | canonical | — | mirror |
| `OPERATOR_ALERT_TEST_SECRET` | canonical | — | mirror |
| `TELEGRAM_BOT_TOKEN` | canonical (for prod backend's notifier) | mirror (for staleness alerts) | — |
| `TELEGRAM_OPERATOR_CHAT_ID` | canonical | mirror | — |

All three secret files live on the homelab now (Q2 moved off the dev box
2026-05-21). On rotation: update `backend/.env` first, restart backend
(`pnpm run deploy:homelab`), then propagate to the other two files by
hand. A `scripts/verify-secrets-sync.sh` probe is filed as a future
enhancement.

## Q2 deferred follow-ups (non-blocking, priority order)

These were filed across the Q2 → Q2b → Q2c → Q2d review rounds; none
block the live cron. Pick in order of payoff:

1. **~~`/api/v1/operator/cron-failure` route rename + Telegram template fix~~ — PARTIALLY CLOSED 2026-05-22.**
   The **template-fix half (part b)** landed: `operator-alert-transport.ts::buildHeader`
   now renders `Info:` / `Warn:` / `Error:` per the payload's
   `severity` field. Telegram heartbeats no longer read as
   `Error: YieldCronBootAlert` / `Error: AlertTestPing` — the prefix
   matches the icon. The `Token:` field still carries the cron's
   sentinel symbol (`YIELD_CRON_HEARTBEAT` for the daily yield-cron
   ping; `CONFIG_TEST` for the legacy alert-test surface) until the
   route-rename half ships.
   **Still deferred (parts a + c + d):**
   - `/api/v1/operator/cron-failure` route rename (DTO accepts
     `severity` + `source`; keeps `alert-test` as a thin synonym for
     one release).
   - `Token:` field renders the `source` (`q2-heartbeat` /
     `q3-yield-cron`) instead of legacy hardcodes.
   - Wrapper at `scripts/refresh-and-ingest.sh` passes
     `{severity: 'info', source: 'q2-heartbeat'}` to the new route.

   Original surfacing context (kept for the route-rename half):
   Round-1 Security M-1 + Round-2 Software Architect MED. The
   pre-fix operator-confirmed misread was:

   ```
   ℹ️ Token: CONFIG_TEST
   Error: AlertTestPing               ← false positive (icon ≠ label)

   Q2 daily heartbeat OK date=2026-05-21 host=muhaven-VMware
   ```

   Post-2026-05-22 (after the template-half fix) reads as:

   ```
   ℹ️ Token: CONFIG_TEST              (still the legacy source name)
   Info: AlertTestPing                ← now matches the icon

   Q2 daily heartbeat OK date=2026-05-21 host=muhaven-VMware
   ```
2. **`scripts/verify-secrets-sync.sh`** (~30 min). Read-only probe of
   all 3 secret-holding files (`backend/.env`, `.monitor.env`,
   `scripts/refresh-and-ingest.env`). Reports drift between
   `ORACLE_INGEST_SERVICE_SECRET` / `OPERATOR_ALERT_TEST_SECRET` /
   `TELEGRAM_*` values without exposing them in the output. Run before
   any secret rotation.
3. **`flock` against manual + scheduled race** (~30 min).
   `MultipleInstances=IgnoreNew` (Linux systemd) + `IgnoreNew` (Win Task
   Scheduler) only protect scheduled-vs-scheduled. A manual
   `systemctl start muhaven-oracle-refresh.service` while a scheduled
   tick is mid-scrape would deadlock on the Chromium SingletonLock. Add
   `flock` at the top of `scripts/refresh-and-ingest.sh` against
   `${ORACLE_DIR}/_debug/.wrapper.lock`. Round-1 Code Reviewer M-2.
4. **npm supply-chain pinning for `scripts/oracle-mine/`** (~1h).
   Currently `npm install` runs lifecycle scripts including
   `postinstall: playwright install chromium`. Switch the operator
   bootstrap to `npm ci --ignore-scripts` + commit `package-lock.json`
   + extend `scripts/refresh-and-ingest.sh`'s preflight to verify the
   lockfile checksum hasn't changed since install. Round-1 Security H-4.
5. **Automated absence-of-heartbeat detector** (~1h). Today the Q2d
   daily heartbeat is OPERATOR-monitored (operator notices missing
   daily Telegram ping). Options for automation:
   - External Healthchecks.io probe (adds third-party dep + a new
     secret).
   - In-backend `cron_state` table tracks `last-heartbeat-at` per
     cron; a separate poller alerts if the gap exceeds a threshold.
     Bigger lift but aligns with Q3's existing `cron_state` pattern.
   Round-2 DevOps INFO + Round-3 DevOps L-2.
6. **`scripts/deploy-homelab.sh` ungitignore** (~1h). Currently
   gitignored (operator-specific hostnames + SSH key paths). Local
   edits don't propagate; future operators rebuilding from scratch
   lose the step 5e Q2-sync block. Either parameterise the
   operator-specific bits via env vars and ungitignore, or commit the
   canonical step 5e block to a tracked sibling script that gets
   sourced by the gitignored wrapper. Surfaced when Q2b landed.
7. **RPC provider redundancy via viem `fallback` transport** (~2h).
   Single-RPC-provider topology surfaced 2026-05-21 02:23 UTC: a
   transient `getaddrinfo EAI_AGAIN
   arbitrum-sepolia.api.onfinality.io` froze both `TaxEventIndexer`
   and `BlockchainEventPoller` until DNS resolution self-recovered
   later that day. No data loss (in-memory cursor; zero on-chain
   events during the window), but a longer outage on the same single
   endpoint would block indexing indefinitely. Switch the viem client
   in `backend/src/infrastructure/blockchain/index.ts` from `http(URL)`
   to `fallback([http(onfinality), http(alchemy), http(arbitrumPublic)])`;
   add `BACKUP_RPC_URL_1` / `BACKUP_RPC_URL_2` to `backend/.env.example`
   + the deploy playbook. **Escalation trigger:** the 2026-05-21
   incident is the recurrence-clock-start. If the same `EAI_AGAIN` on
   the same hostname recurs before **2026-06-04** (~2 weeks), promote
   this from deferred → active and ship in the same PR as
   root-cause closure. A second incident inside the resolver-flap
   cache window is the signal that a single-provider topology is the
   load-bearing problem. Full incident close-out in
   `memory/project_taxeventindexer_dns_fix.md` (operator-local).

## When the operator outgrows this layout

Migration triggers (from the Wave 5 Q2 architecture review):

- **Multi-person team** → Q2 wrapper moves to a CI runner (GitHub Actions cron);
  headless scrape replaces persistent Chromium profile; secrets become
  per-runner credentials.
- **Cloud-scrape lands** (Browserbase / Cloudflare Browser Rendering /
  dedicated EC2) → `scripts/oracle-mine/` retires; wrapper becomes
  an HTTP client; systemd timer + Task Scheduler both retire; everything
  consolidates onto the in-backend `node-cron` scheduler.
- **Audit-grade compliance** → `/api/v1/operator/alert-test` retires in
  favour of `/api/v1/operator/cron-failure` with severity in the DTO;
  `refresh-history.log` becomes a database table with retention policy.
