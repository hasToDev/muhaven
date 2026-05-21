# Operator Crons

MuHaven runs four scheduled tasks. All canonical hosts are on the homelab
(`192.168.1.52`, GUI Ubuntu 24.04 LTS with autologin). This file is the
central index — when one of them drifts, the runbook below tells you which
mechanism owns it, how it alerts, and where the per-cron notes live.

| Cron | Mechanism | Schedule | Failure detector | Escalation | Runbook |
|---|---|---|---|---|---|
| YieldDistributionCron | Backend docker container (node-cron) | Daily at `00:00 UTC` | Per-tick try/catch + `notifyYieldCronFailure` → Telegram | Immediate Telegram on phase failure; boot-alert on every backend restart | `backend/src/infrastructure/blockchain/yield-cron.ts` header; `development/DEV_WAVE_5/Q3_PLAN.md` |
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
```

No registration step — `pnpm run deploy:homelab` brings it up with the backend.

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
