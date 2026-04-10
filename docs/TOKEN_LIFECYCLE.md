# Token Lifecycle Management

> Post-hackathon feature spec. Architecture hooks are in place (Wave 3); full implementation is deferred.

---

## Overview

Every RWA token on MuHaven has a lifecycle. Issuers need the ability to pause operations, settle outstanding positions, force-redeem remaining investors, and archive the token when the underlying asset matures, is redeemed, or is no longer offered.

This document specifies the four-state lifecycle model, the responsibilities at each state transition, data archival policy, and the contract/backend/frontend touch points.

---

## Lifecycle States

```
┌──────────┐   pause()    ┌──────────┐   windDown()   ┌──────────────┐   archive()   ┌───────────┐
│  ACTIVE  │ ───────────→ │  PAUSED  │ ─────────────→ │ WINDING_DOWN │ ────────────→ │ ARCHIVED  │
│          │ ←─────────── │          │                 │              │               │           │
└──────────┘  unpause()   └──────────┘                 └────────────���─┘               └───────────┘
                                                       (forced redemption             (terminal state,
                                                        period, yield                  contract frozen,
                                                        settlement)                    data retained)
```

| State | Minting | Transfers | Yield Distribution | Investor Redemption | Visible in Marketplace | Data Writes |
|-------|---------|-----------|-------------------|--------------------|-----------------------|-------------|
| **Active** | Yes | Yes | Yes | Yes | Yes | Full (NAV, yields, activity) |
| **Paused** | No | No | Pending distributions complete | Yes (unwrap only) | Yes (with "Paused" badge) | Full |
| **Winding Down** | No | No | Final settlement only | Yes (forced after grace) | No (hidden) | Settlement records only |
| **Archived** | No | No | No | No (fully settled) | No | Read-only (no new writes) |

---

## State Transitions

### Active → Paused

**Trigger:** Issuer calls `pause()` on `MuHavenToken` (onlyOwner).

**On-chain effects:**
- `mint()`, `transfer()`, `transferFrom()` revert via `whenNotPaused` modifier
- `MuHavenVault.wrap()` reverts (vault already has `whenNotPaused`)
- `MuHavenVault.unwrap()` remains allowed — investors can exit
- Any in-progress `YieldDistributor.processBatch()` calls complete (distribution is atomic per batch)

**Backend effects:**
- `rwa_tokens.status` updated to `paused`, `pausedAt` timestamp set
- `GET /api/v1/tokens` returns token with `status: "paused"`
- `POST /api/v1/deposit` rejects deposits for this token
- `POST /api/v1/issuer/distribute` rejects new distributions for this token

**Frontend effects:**
- TokensPage shows "Paused" badge on the token card
- Marketplace/browse page shows token with "Paused — no new investments" indicator
- DepositPage disables this token in the token selector
- PortfolioPage shows investor's existing position with "Token Paused" notice

**Reversibility:** Yes — issuer can call `unpause()` to return to Active state.

---

### Paused → Winding Down

**Trigger:** Issuer calls backend endpoint `POST /api/v1/issuer/tokens/:address/wind-down`.

**Preconditions (enforced by backend):**
1. Token must be in `paused` state
2. All in-progress yield distributions for this token must be `COMPLETED`
3. No pending escrows for this token (all settled or expired)

**On-chain effects:**
- No new on-chain state change required — the token is already paused
- Issuer can optionally renounce minter role to signal permanence

**Backend effects:**
- `rwa_tokens.status` updated to `winding_down`, `windingDownAt` timestamp set
- Token removed from `GET /api/v1/tokens` default listing (available via `?include_archived=true`)
- Redemption grace period starts (configurable, default 90 days)
- Backend tracks: unredeemed investor count, total unredeemed supply, grace period countdown
- Notification schedule begins: reminders at 60 days, 30 days, 7 days, 1 day before grace period ends

**Frontend effects:**
- Token removed from marketplace/browse page
- TokensPage (issuer) shows token in "Winding Down" section with:
  - Settlement progress (redeemed / total investors)
  - Unredeemed supply
  - Grace period countdown
  - "Force Redeem Remaining" button (enabled after grace period)
- PortfolioPage shows investor's remaining position with "Token winding down — please redeem" notice and countdown
- Agent proactively notifies affected investors

**Reversibility:** No — winding down is irreversible. The issuer has committed to removing the token.

---

### Winding Down → Archived

**Trigger:** Either:
1. All investors have voluntarily redeemed (unredeemed supply = 0), OR
2. Grace period expires and issuer calls `POST /api/v1/issuer/tokens/:address/archive` (triggers forced redemption for remaining holders)

**Preconditions (enforced by backend):**
1. Token must be in `winding_down` state
2. Either: all investors redeemed, OR grace period has expired

**On-chain effects (forced redemption, if needed):**
- For each remaining holder: `forceUnwrap()` burns fhERC-20 tokens and sends underlying ERC-20 to investor's address
- Requires ERC-3643 `forcedTransfer()` authority (compliance agent role)
- Issuer can optionally renounce ownership to make the contract permanently frozen
- Contract remains deployed on-chain (immutable record) but all balances are zero

**Backend effects:**
- `rwa_tokens.status` updated to `archived`, `archivedAt` timestamp set
- Data archival process begins (see [Data Archival](#data-archival) section below)
- Token excluded from all default API queries
- Historical data remains accessible via explicit archive queries

**Frontend effects:**
- Token fully removed from all active views
- TokensPage (issuer) shows token in collapsed "Archived" section with final summary:
  - Total lifetime yield distributed
  - Total investors served
  - Active period (createdAt → archivedAt)
  - Final NAV at time of wind-down
- PortfolioPage: if investor held this token, shows in "Past Investments" section (read-only)
- YieldsPage: historical yield records remain visible in history, tagged with token status

**Reversibility:** No — archived is a terminal state. A new token must be created if the asset is re-offered.

---

## Data Archival

When a token transitions to `archived`, data enters a retention and archival pipeline. The goal is to keep data accessible for compliance and historical reporting while reducing active database load.

### Data Categories

| Data Type | Source | Retention (Active DB) | Long-Term Archive | Access After Archival |
|-----------|--------|----------------------|-------------------|-----------------------|
| **Token metadata** | `rwa_tokens` | Permanent | N/A (stays in main table) | `GET /api/v1/tokens/:address?include_archived=true` |
| **NAV history** | `token_nav_history` | 1 year post-archive | Export to cold storage (JSON/Parquet) | Archive API or exported file |
| **Yield records** | `yield_records` | 7 years (regulatory) | Export to cold storage after 7y | `GET /api/v1/yields?include_archived=true` |
| **Portfolio records** | `portfolios` | 1 year post-archive | Export to cold storage | `GET /api/v1/portfolio/history` |
| **Activity/events** | `escrow_events` | 7 years (regulatory) | Export to cold storage after 7y | `GET /api/v1/activity?include_archived=true` |
| **On-chain state** | Smart contracts | Permanent (blockchain) | N/A (immutable) | Direct contract reads or block explorer |

### Retention Rules

1. **Regulatory minimum (7 years):** Yield distribution records, escrow events, and transaction activity for securities tokens must be retained for at least 7 years per SEC/FINRA record-keeping requirements. This applies to `yield_records` and `escrow_events`.

2. **Operational retention (1 year):** NAV history and portfolio snapshots for archived tokens are kept in the active database for 1 year after archival to support historical performance queries. After 1 year, they are exported to cold storage.

3. **Permanent in active DB:** The `rwa_tokens` row itself (with `status: 'archived'`) stays permanently — it's a lightweight record that serves as the index for all archived data.

4. **On-chain data:** Smart contract state is immutable and permanently accessible on the blockchain. This is the authoritative source of truth for balances, distributions, and escrow records.

### Archive Process

When a token is archived, the backend runs the following pipeline (can be async/background job):

```
1. Freeze NAV worker
   └─ nav-worker stops fetching for this token (remove from token → source mapping)

2. Snapshot final state
   ├─ Record final NAV, total AUM, total yield distributed, investor count
   ├─ Record final distribution summary (total distributions, total amount)
   └─ Store as `archive_summary` JSON field on `rwa_tokens` row

3. Mark related records
   ├─ yield_records for this token: add `archived_at` timestamp
   ├─ portfolios for this token: add `archived_at` timestamp
   └─ No deletion — records remain queryable with archive filter

4. Export to cold storage (deferred, runs on schedule)
   ├─ After 1 year: export token_nav_history rows to JSON/Parquet → delete from active DB
   ├─ After 7 years: export yield_records and escrow_events → delete from active DB
   └─ Store exports in object storage (S3/R2) with token address as key

5. Update indexes
   └─ Ensure archived tokens are excluded from default queries via status filter
```

### Database Schema Additions (for archival)

```sql
-- Added to rwa_tokens for archive summary
ALTER TABLE rwa_tokens
  ADD COLUMN archive_summary JSONB;
  -- Contains: { finalNav, totalAum, totalYieldDistributed, totalInvestors,
  --             totalDistributions, activePeriodDays, archivedReason }

-- Added to yield_records and portfolios for archive tracking
ALTER TABLE yield_records ADD COLUMN archived_at TIMESTAMP;
ALTER TABLE portfolios ADD COLUMN archived_at TIMESTAMP;
```

### Cold Storage Format

Exported data uses Parquet format (columnar, compressed, query-friendly) with the following structure:

```
archive/
  {token_address}/
    metadata.json           — token metadata + archive summary
    nav_history.parquet     — full NAV time-series
    yield_records.parquet   — all yield distribution records
    escrow_events.parquet   — all escrow lifecycle events
    portfolios.parquet      — investor position snapshots
```

> **Hackathon scope:** Cold storage export is post-hackathon. For MVP, archived tokens stay in the active database indefinitely with status-based filtering. The `archive_summary` JSON field on `rwa_tokens` is the only archival-specific addition needed during Wave 3 hooks.

---

## Architecture Hooks (In Place — Wave 3)

These structural elements are implemented during Wave 3 to ensure future compatibility:

### Contract Layer
- `MuHavenToken.sol` inherits `PausableUpgradeable` with `pause()` / `unpause()` (onlyOwner)
- `mint()`, `transfer()`, `transferFrom()` gated by `whenNotPaused`
- `MuHavenVault.sol` already has `PausableUpgradeable` (wrap gated, unwrap allowed)

### Backend Layer
- `rwa_tokens` table has `status` column (`tokenStatusEnum: active | paused | winding_down | archived`)
- `rwa_tokens` table has `updatedAt`, `pausedAt`, `windingDownAt`, `archivedAt` timestamp columns
- `RwaToken` domain entity has status field + transition validation methods (`canPause`, `canUnpause`, `canWindDown`, `canArchive`)
- `IRwaTokenRepository` has `updateStatus()` and `findByStatus()` methods

### Frontend Layer
- `ISSUER_TOKENS` mock data includes `status` field
- TokensPage renders status badges based on token status
- DepositPage token selector respects token status (disabled if not active)

---

## API Endpoints (Post-Hackathon)

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/api/v1/issuer/tokens/:address/pause` | Pause token (calls contract + updates DB) | Issuer |
| POST | `/api/v1/issuer/tokens/:address/unpause` | Unpause token | Issuer |
| POST | `/api/v1/issuer/tokens/:address/wind-down` | Begin wind-down (checks preconditions, starts grace period) | Issuer |
| GET | `/api/v1/issuer/tokens/:address/wind-down-status` | Wind-down progress (unredeemed count, grace countdown) | Issuer |
| POST | `/api/v1/issuer/tokens/:address/archive` | Archive token (force-redeem if grace expired, freeze data) | Issuer |
| GET | `/api/v1/tokens?include_archived=true` | Include archived tokens in listing | Public |
| GET | `/api/v1/portfolio/history` | Past investments in archived tokens | Access token |

---

## Database Schema

```sql
-- tokenStatusEnum defined in Wave 3 (four states)
CREATE TYPE token_status AS ENUM ('active', 'paused', 'winding_down', 'archived');

-- Columns added to rwa_tokens in Wave 3
ALTER TABLE rwa_tokens
  ADD COLUMN status token_status NOT NULL DEFAULT 'active',
  ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  ADD COLUMN paused_at TIMESTAMP,
  ADD COLUMN winding_down_at TIMESTAMP,
  ADD COLUMN archived_at TIMESTAMP;

-- Post-hackathon additions for archival
ALTER TABLE rwa_tokens ADD COLUMN archive_summary JSONB;
ALTER TABLE yield_records ADD COLUMN archived_at TIMESTAMP;
ALTER TABLE portfolios ADD COLUMN archived_at TIMESTAMP;
```

---

## ERC-3643 Alignment

The token lifecycle aligns with ERC-3643 compliance operations:

| MuHaven Lifecycle | ERC-3643 Equivalent |
|-------------------|---------------------|
| `pause()` | `pause()` — halts all transfers |
| `unpause()` | `unpause()` — resumes transfers |
| Winding Down (forced redemption) | `forcedTransfer()` — agent-authorized transfers |
| Freeze individual | `freeze(address)` — per-account freeze (not in lifecycle, but available) |
| Archive | No direct equivalent — ERC-3643 tokens can be burned but not "archived" |

The current `ERC3643KYCAdapter` uses a simplified whitelist. When full ONCHAINID integration is implemented, the lifecycle operations will be gated by compliance agent roles rather than `onlyOwner`.

---

## Implementation Priority

| Component | Priority | Depends On |
|-----------|----------|------------|
| Contract `pause()`/`unpause()` | Wave 3 (hook) | — |
| Backend status column (4 states) + domain entity | Wave 3 (hook) | — |
| Frontend status badges | Wave 3 (hook) | — |
| Issuer pause/unpause API + UI | Post-hackathon | Wave 3 hooks |
| Issuer wind-down API + UI | Post-hackathon | Pause API |
| Grace period + notifications | Post-hackathon | Wind-down API |
| Forced redemption (`forceUnwrap`) | Post-hackathon | ERC-3643 full integration |
| Archive API + final summary | Post-hackathon | Wind-down complete |
| Archive summary JSON field | Post-hackathon | Archive API |
| Cold storage export pipeline | Post-hackathon (low priority) | Archive API + object storage |
| Investor notification system | Post-hackathon | Backend webhook integration |

---

*This document will be updated as the feature is implemented. Architecture hooks are tracked in `development/DEV_WAVE_3/PROGRESS.md`.*
