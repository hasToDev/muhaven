# Operator Crons

MuHaven runs four scheduled tasks across two hosts. This file is the central
index — when one of them drifts, the runbook tells you which host owns it,
how it alerts, and where the per-cron notes live.

| Cron | Host | Schedule | Failure detector | Escalation | Runbook |
|---|---|---|---|---|---|
| YieldDistributionCron | Homelab (`192.168.1.52`, backend container) | Daily at `00:00 UTC` | Per-tick try/catch + `notifyYieldCronFailure` → Telegram | Immediate Telegram on phase failure; boot-alert on every backend restart | `backend/src/infrastructure/blockchain/yield-cron.ts` header; `development/DEV_WAVE_5/Q3_PLAN.md` |
| oracle-staleness-check.sh | Homelab (`192.168.1.52`, host cron, NOT docker) | `*/30 * * * *` | Per-token `getNAV().updatedAt` age vs `THRESHOLD_HR` (default 28h) | Telegram alert per stale token; backstop for ALL upstream NAV pipelines | `scripts/oracle-staleness-check.sh` header; `development/DEV_WAVE_3/HOMELAB_DEPLOY.md` "Oracle staleness monitor" |
| nav-publisher | Homelab (`192.168.1.52`, dedicated docker service) | Per-token internal scheduler; refreshes a token when its on-chain NAV age ≥ ½ of contract max-staleness | Container restart loop + structured logs | Surfaces as stale NAV at the 28h backstop above | `nav-publisher/src/publisher.ts`; `project_design_a_navwriter_pattern` memory |
| refresh-and-ingest (Wave 5 Q2) | **Operator dev box** (Windows + Git Bash + Task Scheduler) | `07:00 / 15:00 / 23:00` local = `00 / 08 / 16 UTC` at +7 | Per-phase exit code + partial-scrape detection (refresh-history.log `failed=...` match) | Telegram via `/api/v1/operator/alert-test`; `notify=fail` history outcome when alert delivery itself broke; 28h backstop above | `scripts/refresh-and-ingest.sh` header; `development/ORACLE_DATA_MINE/README.md` "8-hour cron" section |

## Failure-detection topology

The four crons are layered, not independent:

```
fresh rwa.xyz data ──► (Q2 refresh-and-ingest, 8h)
                              │ writes oracle_snapshots
                              ▼
on-chain NAV  ──► (nav-publisher, per-token cadence)
                              │ calls IssuerControlledOracle.setNAV
                              ▼
                ┌─────────────────────────────┐
                │  Token's `getNAV().updatedAt`│ ◄── (oracle-staleness-check.sh, 30min poll, 28h alert)
                └─────────────────────────────┘
                              │
                              ▼
distributable yield ──► (YieldDistributionCron, daily 00 UTC)
```

If Q2 breaks → fresh data stops flowing in → nav-publisher re-stamps the
last-known NAV (synthetic-token fallback, see `project_design_a_navwriter_pattern`)
→ on-chain NAV stays fresh-looking for a while → staleness-check eventually
alerts at 28h IF nav-publisher ALSO drifts. Q2's own Telegram alert is the
8h-granularity signal; the 28h backstop is the safety net.

## Operator install rituals

### Q2 refresh-and-ingest (dev box, one-time)

```bash
cp scripts/refresh-and-ingest.env.example scripts/refresh-and-ingest.env
# edit: fill ORACLE_INGEST_SERVICE_SECRET + OPERATOR_ALERT_TEST_SECRET from
#       homelab backend/.env
bash scripts/refresh-and-ingest.sh                          # manual smoke
pwsh scripts/windows/install-oracle-refresh-task.ps1        # register
```

Verify / uninstall:

```bash
pwsh -c "Get-ScheduledTask -TaskName 'MuHaven\OracleRefresh' | Get-ScheduledTaskInfo"
pwsh -c "Start-ScheduledTask -TaskName 'MuHaven\OracleRefresh'"
pwsh scripts/windows/uninstall-oracle-refresh-task.ps1
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

### YieldDistributionCron (homelab)

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

| Secret | Homelab `backend/.env` | Homelab `.monitor.env` | Dev box `scripts/refresh-and-ingest.env` |
|---|---|---|---|
| `ORACLE_INGEST_SERVICE_SECRET` | canonical | — | mirror |
| `OPERATOR_ALERT_TEST_SECRET` | canonical | — | mirror |
| `TELEGRAM_BOT_TOKEN` | canonical (for prod backend's notifier) | mirror (for staleness alerts) | — |
| `TELEGRAM_OPERATOR_CHAT_ID` | canonical | mirror | — |

On rotation, update homelab `backend/.env` first, restart backend
(`pnpm run deploy:homelab`), then propagate to the other two surfaces
by hand. No automation today; a `scripts/verify-secrets-sync.sh` probe is
filed as a future enhancement.

## When the operator outgrows this layout

Migration triggers (from the Wave 5 Q2 architecture review):

- **Multi-person team** → Q2 wrapper moves to a CI runner (GitHub Actions cron);
  headless scrape replaces persistent Chromium profile; secrets become
  per-runner credentials.
- **Cloud-scrape lands** (Browserbase / Cloudflare Browser Rendering /
  dedicated EC2) → `development/ORACLE_DATA_MINE/` retires; wrapper becomes
  an HTTP client; Task Scheduler retires; everything consolidates onto the
  in-backend `node-cron` scheduler.
- **Audit-grade compliance** → `/api/v1/operator/alert-test` retires in
  favour of `/api/v1/operator/cron-failure` with severity in the DTO;
  `refresh-history.log` becomes a database table with retention policy.
