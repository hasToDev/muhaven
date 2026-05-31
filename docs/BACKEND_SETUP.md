# Backend Setup

> Docker Compose stack (postgres + backend + fhe-worker + nav-worker + nav-publisher + telegram-bot), env configuration, deploy flow, and Cloudflare tunnel setup.

For day-to-day homelab operation see the internal `development/DEV_WAVE_3/HOMELAB_DEPLOY.md` (prod) and `development/STAGING.md` (staging). This doc is the canonical reader-facing guide.

---

## Overview

```
              ┌──────────────────────┐
 frontend ──→ │  Cloudflare tunnel   │ ──→  backend:3000  ──┬──→  postgres:5432
              │  api.muhaven.app     │                      │
              └──────────────────────┘                      ├──→  fhe-worker:3001
                                                            │
                                                            └──→  nav-worker:3002
                                                                        │
                          nav-publisher ──→ on-chain oracle             └──→ postgres:5432
                          telegram-bot  ──→ backend:3000
```

| Service | Port | Role | Depends on |
|---------|------|------|-----------|
| `postgres:16` | 5432 | Drizzle schema store: users, sessions, nonces, escrows, withdrawals, rwa_tokens, portfolios, yield_records, escrow_events, nav_history, tax_events, scoped sessions, audit/cron state | — |
| `backend` | 3000 | REST API: auth, portfolio, yields, deposit/withdraw, issuer, agent, MCP/operator endpoints, webhooks | postgres (healthy), fhe-worker (started) |
| `fhe-worker` | 3001 | Server-side CoFHE encryption via `@cofhe/sdk/node` (used by backend for agent flows) | — |
| `nav-worker` | 3002 | Periodic NAV fetcher — FRED, on-chain oracles, fallbacks — writes to `nav_history` | postgres (healthy) |
| `nav-publisher` | — | On-chain NAV writer: pushes per-token NAV to `IssuerControlledOracle.setNAV`, deviation- and sequencer-uptime-gated; per-token internal scheduler (refreshes when on-chain NAV age ≥ ½ contract max-staleness) | postgres (healthy) |
| `telegram-bot` | — | Operator Telegram bot (alerts, `/revoke_session` kill-switch) — long-polls Telegram, calls back into `backend:3000` | backend |

Only port 3000 is exposed publicly via the Cloudflare tunnel. All intra-stack traffic uses Docker DNS names (`postgres`, `fhe-worker`, `nav-worker`). `nav-publisher` and `telegram-bot` expose no inbound ports.

Prod runs on the homelab as compose project `muhaven` (master branch → `api.muhaven.app`); staging runs side-by-side as project `muhaven-stage` (develop branch → `api-stage.muhaven.app`) via `docker-compose.stage.yml`. The two stacks are physically isolated; postgres is never touched on redeploy. See `development/STAGING.md` for the staging runbook.

---

## Prerequisites

- **Docker** 24+ and `docker compose` v2 (Docker Desktop on macOS/Windows; distro package on Linux)
- **pnpm** 9+ on your dev machine (migrations are run from the dev machine, not inside a container)
- **Node.js** 20+ on your dev machine
- An SSH target for the homelab (or any Linux host) with Docker installed — the included deploy script assumes this layout
- A Cloudflare account with a zone you control (only required for public exposure)

---

## Configuration

All env vars are read at container startup. Update a file and restart the affected service — `docker compose restart backend` picks up new values. Backend runs under `tsx`, so source edits do not need a rebuild; fhe-worker and nav-worker do.

### Root `.env` (docker-compose only)

| Var | Default | Purpose |
|-----|---------|---------|
| `DB_PASSWORD` | `muhaven` | Sets `POSTGRES_PASSWORD` and appears in backend/nav-worker `DATABASE_URL`. Override in production. |

### `backend/.env`

Generated from `backend/.env.example`. Key variables:

**Core**

| Var | Example | Notes |
|-----|---------|-------|
| `DB_PROVIDER` | `postgres` | — |
| `DATABASE_URL` | `postgresql://muhaven:muhaven@postgres:5432/muhaven` | Uses Docker DNS name inside the compose network |
| `PORT` | `3000` | — |
| `LOG_LEVEL` | `info` | Pino level |
| `ALLOWED_ORIGINS` | `http://localhost:7778,https://muhaven.app` | CORS whitelist |

**Auth**

| Var | Example | Notes |
|-----|---------|-------|
| `JWT_SECRET` | *(32+ char base64url — generate per deployment)* | Do not reuse across environments |
| `JWT_ISSUER` | `muhaven.xyz` | Static |
| `ACCESS_TOKEN_TTL` | `3600` | Seconds |
| `REFRESH_TOKEN_TTL` | `2592000` | Seconds (30 days) |

**Chain**

| Var | Example | Notes |
|-----|---------|-------|
| `CHAIN_ID` | `421614` | Arbitrum Sepolia |
| `RPC_URL` | `https://sepolia-rollup.arbitrum.io/rpc` | Public or custom |
| `REINEIRA_COORDINATOR_URL` | `https://dswtxw6k9mker.cloudfront.net` | Fhenix CoFHE testnet coordinator |

**Contract addresses**

Authoritative deployed addresses live in `deployments/arb-sepolia-v2.json` (prod) and
`deployments/arb-sepolia-v2.staging.json` (staging) — the platform contracts plus the per-token
stacks (`tokens.<SYMBOL>.contracts`). The legacy `deployments/arb-sepolia.json` is a read-only
artifact from the original single-token deploy. The backend reads platform singletons plus
per-token JSON maps (`MUHAVEN_TOKEN_ADDRESSES_JSON`, `YIELD_SNAPSHOT_*`, `REDEMPTION_QUEUE_*`,
`TREASURY_*`). Key platform addresses:

| Var / field | Contract |
|-------------|----------|
| `MuHavenStable` (`PUSDC_ADDRESS`) | Confidential USDC wrapper — ticker **`mhUSDC`** (contract `MuHavenStable`; the env var keeps the historical `PUSDC_ADDRESS` name) |
| `TokenRegistry` | Per-token config registry (issuer, oracle, paused state) |
| `MuHavenSubscription` | Buy/sell primary-market engine |
| `YieldSnapshot` | Two-phase yield snapshot + claim state machine |
| `IssuerControlledOracle` | On-chain NAV oracle (written by `nav-publisher`) |
| `InvestorRegistry` | Holder enumeration proxy |
| ERC-3643 stack | `MuHavenIdentityRegistry`, `ClaimTopicsRegistry`, `TrustedIssuersRegistry`, `ModularCompliance` |
| `external.kycAdapter` | ERC-3643 KYC adapter (whitelist for testnet) |
| `external.legacyPusdc` | Legacy ReineiraOS ConfidentialUSDC (rotated out at the mhUSDC cutover; kept for back-compat) |
| `CIRCLE_USDC_ADDRESS` | Circle USDC on Arb Sepolia (`0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`) |

Per-token contracts (one set per onboarded RWA token, 11 active): `MuHavenToken` (fhERC-20 proxy), `MuHavenTreasury` (ERC-20 ↔ fhERC-20 wrapper), `RedemptionQueue`.

**Services**

| Var | Example | Notes |
|-----|---------|-------|
| `FHE_WORKER_URL` | `http://fhe-worker:3001` | Docker DNS inside compose; `http://localhost:3001` outside |
| `FHE_WORKER_SHARED_SECRET` | *(random hex, ≥32 chars)* | When set, backend forwards as `X-FHE-Worker-Secret` header to fhe-worker's `/api/v1/encrypt/for-account` endpoint; worker rejects 401 on mismatch. When unset on either side, the gate is open (back-compat for ops who haven't rotated env). Generate with `openssl rand -hex 32`. |

**Block poller** (optional)

| Var | Example | Notes |
|-----|---------|-------|
| `BLOCK_POLLER_ENABLED` | `false` | Set `true` to observe `EscrowIdsAttached` + `EscrowRedeemed` |
| `BLOCK_POLLER_INTERVAL_MS` | `15000` | Poll cadence |

**Demo / webhooks**

| Var | Example | Notes |
|-----|---------|-------|
| `DEMO_WHITELIST_PRIVATE_KEY` | *(empty in prod)* | Admin key for self-serve demo whitelist endpoint |
| `QUICKNODE_WEBHOOK_SECRET` | *(empty)* | Reserved for future QuickNode event webhook auth |

### `fhe-worker/.env`

| Var | Example | Notes |
|-----|---------|-------|
| `PORT` | `3001` | — |
| `RPC_URL` | `https://sepolia-rollup.arbitrum.io/rpc` | Same as backend |
| `FHE_WORKER_PRIVATE_KEY` | *(64 hex chars, 0x-prefixed)* | Dedicated wallet for server-side encryption permits. **Must not be the deployer key.** If empty, `/health` still passes but encryption calls return 503. |
| `FHE_WORKER_SHARED_SECRET` | *(must match backend value)* | Gates `POST /api/v1/encrypt/for-account` only. Legacy `/api/v1/encrypt/batch` is unaffected (escrow back-compat). When unset, the gate is open. Set on both sides for production. |

**Worker routes:**
- `POST /api/v1/encrypt/batch` — legacy: encrypt without `setAccount` binding. Used by the escrow flow (works because msg.sender == fhe-worker EOA).
- `POST /api/v1/encrypt/for-account` — encrypt with hard `setAccount(userAddress)` binding so the verifier signature matches the on-chain msg.sender. Gated by `X-FHE-Worker-Secret` header when `FHE_WORKER_SHARED_SECRET` is set on both sides. Includes per-account serialization queue + input cap (50 items) + zero-address reject + per-item type whitelist.
- `POST /api/v1/decrypt/for-tx` — TN-signed decrypt for breach-detection async flow.

### `nav-worker/.env`

| Var | Example | Notes |
|-----|---------|-------|
| `DATABASE_URL` | `postgresql://muhaven:muhaven@postgres:5432/muhaven` | Shared with backend |
| `PORT` | `3002` | — |
| `NAV_FETCH_INTERVAL_MS` | `3600000` | Default 1 hour |
| `FRED_API_KEY` | *(empty)* | Free tier at fred.stlouisfed.org. If empty, treasury-yield sources fall back to static rates. |
| `ETH_MAINNET_RPC_URL` / `ARB_RPC_URL` | *(empty)* | Optional custom RPC for on-chain NAV reads |

---

## Deploy flow

### Dev machine → homelab

```bash
pnpm run deploy:homelab          # prod:  master      → api.muhaven.app
pnpm run deploy:homelab:stage    # stage: develop     → api-stage.muhaven.app
```

Both wrap `scripts/deploy-homelab.sh <env>`. The script is **branch-guarded** (`master` for prod,
`develop` for stage) and always passes `-f` + `-p` so the two compose stacks
(`docker-compose.yml` / project `muhaven` vs `docker-compose.stage.yml` / project `muhaven-stage`)
stay physically isolated. The script:

1. `rsync`s changed files (`backend/`, `fhe-worker/`, `nav-worker/`, `nav-publisher/`, `telegram-bot/`, the compose file) to the homelab. Excludes `node_modules/`, `dist/`, `.env`, `.git/`, and `drizzle/` (declarative push, not versioned migrations). `*.sh` are forced to LF via `.gitattributes` — CRLF line endings break bash on the homelab.
2. SSHes into the homelab and rebuilds the service containers — postgres is never restarted.
3. Waits for `/health` on the backend to return 200 before exiting.

Typical downtime during a redeploy: 3–5s per restarted container. First build takes 5–10 minutes (pnpm install inside each image); subsequent builds hit the layer cache and complete in ~30s.

### Fresh install on a new host

On the target host:

```bash
# Clone
git clone <repo-url> /home/muhaven/MuHaven
cd /home/muhaven/MuHaven

# Populate env files (each service has its own .env)
cp backend/.env.example backend/.env            && edit backend/.env
cp fhe-worker/.env.example fhe-worker/.env      && edit fhe-worker/.env
cp nav-worker/.env.example nav-worker/.env      && edit nav-worker/.env
cp nav-publisher/.env.example nav-publisher/.env && edit nav-publisher/.env
cp telegram-bot/.env.example telegram-bot/.env  && edit telegram-bot/.env

# Bring up the stack
docker compose up -d --build
docker compose ps               # wait for postgres "(healthy)", ~25s
```

Then push the Drizzle schema. **`backend/` is NOT a pnpm workspace member** (the workspace is
`packages/*` + `e2e`), so run `db:push` from inside the backend dir, not via `pnpm --filter`.
The schema lives in `backend/drizzle/schema.ts`; this repo uses Drizzle's declarative `push`, not
versioned migrations. Drizzle Kit reads `DATABASE_URL` from the environment (it does not parse
`.env` files), so set it inline:

```bash
cd backend
pnpm install
DATABASE_URL=postgresql://muhaven:muhaven@<host>:5432/muhaven pnpm db:push
```

Windows PowerShell equivalent:

```powershell
$env:DATABASE_URL = "postgresql://muhaven:muhaven@<host>:5432/muhaven"
pnpm db:push
```

Expected output: `[✓] Changes applied`. On a fresh DB this creates every table/enum in `schema.ts`;
on an existing DB it applies only the additive diff.

For prod / staging (Postgres on the homelab), prefer the operator helper — branch-guarded,
pre-flights the backend container, and invokes `drizzle-kit push` directly inside the container:

```bash
bash scripts/db-push-homelab.sh prod      # master branch only
bash scripts/db-push-homelab.sh stage     # develop branch only
```

### Verify

```bash
curl -s http://localhost:3000/health
# {"status":"ok","timestamp":"..."}

curl -s http://localhost:3001/health
# {"status":"ok","ready":true}

curl -s -X POST http://localhost:3000/api/v1/auth/wallet/nonce \
  -H "Content-Type: application/json" \
  -d '{"wallet_address":"0x1234567890123456789012345678901234567890"}'
# {"nonce":"<uuid>"}
```

---

## Cloudflare tunnel (optional, for public exposure)

Only required if you want a public URL like `api.muhaven.app` → backend:3000.

### One-time setup

```bash
# Install (Ubuntu)
curl -L https://pkg.cloudflare.com/cloudflare-release-key.gpg | \
  sudo gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-main.gpg
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/linux focal main' | \
  sudo tee /etc/apt/sources.list.d/cloudflare-main.list
sudo apt update && sudo apt install cloudflared -y

# Auth + create tunnel
cloudflared tunnel login
cloudflared tunnel create muhaven-api
```

### Config (`~/.cloudflared/config.yml`)

```yaml
tunnel: muhaven-api
credentials-file: /home/muhaven/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: api.muhaven.app
    service: http://localhost:3000
  - service: http_status:404
```

### DNS + systemd

```bash
cloudflared tunnel route dns muhaven-api api.muhaven.app
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

### COOP/COEP headers (required for WebAuthn passkeys)

The Vue frontend uses ZeroDev passkey auth, which requires cross-origin-isolation. Add a Cloudflare Transform Rule → Modify Response Header on the frontend hostname:

- `cross-origin-opener-policy: same-origin`
- `cross-origin-embedder-policy: require-corp`

Without these headers the passkey create/sign dialogs will fail silently in the browser.

---

## Database migrations

The schema lives in `backend/drizzle/schema.ts`. This repo uses Drizzle's **declarative `push`**, not
versioned migration files — `scripts/deploy-homelab.sh` intentionally excludes `drizzle/` from the
rsync. Drizzle Kit reads `DATABASE_URL` from the environment (it does not parse `.env` files), so set
it inline. Run from inside `backend/` (it is not a pnpm workspace member).

| Command | When to use |
|---------|-------------|
| `pnpm db:push` | Idempotent schema push. The canonical flow — first-run and after any `schema.ts` edit. |
| `bash scripts/db-push-homelab.sh prod\|stage` | Run the push inside the deployed homelab backend container (branch-guarded). |
| `pnpm db:studio` | Launch Drizzle Studio on :5555 |

Full wipe:

```bash
docker compose down -v              # -v drops the pgdata volume
docker compose up -d --build
DATABASE_URL=... pnpm db:push
```

---

## Local dev vs production

| Aspect | Local (Docker Desktop) | Homelab (tunnel) |
|--------|------------------------|------------------|
| `DATABASE_URL` host | `localhost` or `postgres` (from inside container) | `postgres` (compose DNS) |
| `FHE_WORKER_URL` | `http://fhe-worker:3001` (compose) or `http://localhost:3001` (from host) | `http://fhe-worker:3001` |
| `ALLOWED_ORIGINS` | `http://localhost:7778` | Add `https://muhaven.app` |
| Port exposure | 3000, 3001, 3002, 5432 on host loopback | Only 3000 via tunnel; rest internal |
| Frontend | `bun run dev:stage` on 7778 (use `dev:stage` locally — `dev`'s ZeroDev RP ID fails on localhost) | served from `muhaven-web` / `muhaven-web-stage` |

When connecting from a dev machine to a homelab postgres, forward 5432 over SSH:

```bash
ssh -L 5432:localhost:5432 muhaven@<homelab>
# psql postgresql://muhaven:muhaven@localhost:5432/muhaven
```

---

## Troubleshooting

**`backend` exits immediately after `docker compose up`.** Postgres health check hasn't passed yet. Wait 15–30s and re-check `docker compose ps`. If the loop continues, inspect `docker compose logs postgres`.

**`pnpm db:push` fails with `ECONNREFUSED`.** Your `DATABASE_URL` points at `postgres` but you're running it outside Docker — use `localhost` (or the homelab IP after SSH forwarding).

**`fhe-worker` logs `No private key configured`.** `FHE_WORKER_PRIVATE_KEY` is missing. The worker stays up for health probing but `/encrypt` returns 503. Generate a fresh wallet and fund it with a bit of ETH on Arb Sepolia for gas (the worker signs CoFHE permits, not chain txs, but some permit flows touch the chain).

**Passkey create dialog never shows.** Check the browser devtools — `SecurityError: The operation is insecure.` indicates missing COOP/COEP headers on the frontend origin. Add the Cloudflare Transform Rule described above.

**`confidentialTransferFrom` reverts with `0x` (empty revert).** This is the known `euint64` selector mismatch documented in `development/DEV_WAVE_3/PUSDC_TRANSFER_ISSUE.md`. The contracts work around it with a low-level call using the legacy `uint256` selector — if you see it from application code, you're calling the legacy ConfidentialUSDC directly instead of through the MuHaven yield pipeline.

**`tsx` not found inside backend container.** `tsx` lives in production deps. If you see this, rebuild without the layer cache: `docker compose build --no-cache backend`.

**nav-worker logs `FRED rate limit` or `no API key`.** Expected without a FRED key — it falls back to hardcoded treasury rates. Register for a free key at fred.stlouisfed.org to fix.

---

## Related docs

- `development/DEV_WAVE_3/HOMELAB_DEPLOY.md` — full homelab runbook with dev-specific shortcuts
- `development/DEV_WAVE_3/SETUP_GUIDE.md` — step-by-step first-time setup narrative
- `docs/TESTNET_DEPLOY.md` — smart-contract deployment to Arbitrum Sepolia
- `development/DEV_WAVE_3/PUSDC_TRANSFER_ISSUE.md` — context on the PUSDC selector workaround
