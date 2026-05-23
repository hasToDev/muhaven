import { randomUUID } from 'node:crypto';
import { NavSnapshot } from '../model/nav-snapshot.js';
import type { OracleSnapshotRead } from '../../oracle/model/oracle-payload.js';

/**
 * Wave 5 — NAV-source split anti-corruption mapping (bug #7,
 * `development/DEV_WAVE_5/NAV_SOURCE_SPLIT.md`, 2026-05-23).
 *
 * Synthesize a `NavSnapshot` from the Q1 `oracle_snapshots` shape so
 * the catalogue endpoint (`GetTokensUseCase`) can return a unified
 * `latest_nav` even for tokens that only exist in the rwa.xyz pipeline.
 *
 * Lives in the `nav-history` domain (not `oracle`) because the OUTPUT
 * is the nav-history bounded context's entity — the function is the
 * load-bearing seam between the two NAV sources. When option C lands
 * (cutover of `GetTokensUseCase` to `oracle_snapshots` entirely; see
 * NAV_SOURCE_SPLIT.md), this file gets deleted along with the dual
 * read path.
 *
 * Returns `null` when `navDollar` is unset — the consumer
 * (`muhaven.position.buy`) needs a NAV value, so a snapshot without
 * one is no better than no fallback.
 *
 * Mapping choices:
 *   - `apy`: `apy7Day → apy30Day` (matches the yield-cron's authoritative
 *     preference at `infrastructure/blockchain/yield-cron.ts`)
 *   - `totalAum`: `totalAssetValueDollar → marketValueDollar` (matches
 *     the ingest mapping at `application/use-case/oracle/ingest-oracle.use-case.ts`)
 *   - `sourceTimestamp`: `rwaxyzUpdatedAt ?? snapshotAt` — prefers the
 *     upstream publish ts. If a downstream consumer ever needs
 *     ingest-freshness (e.g. "stale-NAV badge if older than 24h" across
 *     mixed sources), switch to `snapshotAt`; today's consumer
 *     (MCP `position.buy`) only reads `nav`.
 */
export function navSnapshotFromOracleSnapshot(
  tokenAddress: string,
  snap: OracleSnapshotRead,
): NavSnapshot | null {
  if (!snap.navDollar) return null;
  return new NavSnapshot({
    id: randomUUID(),
    tokenAddress,
    nav: snap.navDollar,
    apy: snap.apy7Day ?? snap.apy30Day ?? undefined,
    totalAum: snap.totalAssetValueDollar ?? snap.marketValueDollar ?? undefined,
    yieldRate: snap.dailyYieldRate ?? undefined,
    source: snap.source,
    sourceType: 'api',
    sourceTimestamp: snap.rwaxyzUpdatedAt ?? snap.snapshotAt,
    fetchedAt: snap.snapshotAt,
    createdAt: snap.snapshotAt,
  });
}
