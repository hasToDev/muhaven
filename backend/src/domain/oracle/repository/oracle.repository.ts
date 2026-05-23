import type {
  OracleAssetWrite,
  OracleSnapshotRead,
  OracleTimeseriesQuery,
  OracleTimeseriesReadPoint,
  TokenListItem,
  TokenMetadataRead,
} from '../model/oracle-payload.js';

export interface IOracleRepository {
  /**
   * Single atomic per-asset write. Runs `token_metadata` upsert +
   * `oracle_snapshots` insert + `oracle_timeseries` chunked upsert
   * inside one Postgres transaction. A failure in any leg rolls back
   * all three so the caller's `status: 'error'` return is truthful.
   *
   * Idempotency:
   *  - `token_metadata` UPSERT on `ticker` — re-runs overwrite display
   *    fields with the latest scrape.
   *  - `oracle_snapshots` INSERT … ON CONFLICT DO NOTHING on natural PK
   *    `(ticker, snapshot_at)` — same-microsecond retries are absorbed
   *    silently. Same-day re-runs (snapshot_at differs by seconds) DO
   *    produce a fresh row, matching the snapshot-ledger model.
   *  - `oracle_timeseries` UPSERT on `(ticker, measure_slug, date)` —
   *    re-running rewrites stale historical values (rwa.xyz back-
   *    corrects) or appends new dates.
   */
  ingestAsset(write: OracleAssetWrite): Promise<{
    metadataUpserted: boolean;
    snapshotInserted: boolean;
    timeseriesPointsUpserted: number;
  }>;

  /**
   * Returns `null` when no metadata row exists for the ticker. The
   * `isYieldBearing` field is the EFFECTIVE value
   * (`is_yield_bearing_override ?? is_yield_bearing`); the raw
   * rwa.xyz flag is also returned for transparency UIs.
   *
   * Case-insensitive lookup — `usyc` and `USYC` both match the
   * canonical row keyed by the case-preserved storage value.
   */
  findMetadata(ticker: string): Promise<TokenMetadataRead | null>;

  /**
   * Marketplace list — card-shape projection of every metadata row
   * with the latest snapshot inlined. Two underlying queries (metadata
   * + DISTINCT ON snapshots) merged in memory. Sorted by ticker so the
   * response is deterministic for cache-key consistency. Bounded by
   * the catalog size (currently 11 rows; designed up to hundreds).
   */
  findMetadataList(): Promise<TokenListItem[]>;

  /**
   * Returns `null` when no snapshot has been ingested for the
   * ticker. Q4's marketplace card + token detail page consume the
   * latest snapshot for hero scalars (NAV / APY / supply).
   */
  findLatestSnapshot(ticker: string): Promise<OracleSnapshotRead | null>;

  /**
   * Wave 5 — bulk-form of `findLatestSnapshot` for the NAV-source
   * split fallback (bug #7, `development/DEV_WAVE_5/NAV_SOURCE_SPLIT.md`).
   * Returns a `Map` keyed by `lower(ticker)` so callers can lookup
   * regardless of the input case. Tickers without any snapshot are
   * absent from the map (NOT `null`-valued). Empty input → empty map
   * without a DB roundtrip.
   *
   * Why this exists separately from `findLatestSnapshot`: `GetTokensUseCase`
   * was fanning out ~9 parallel `findFirst` calls per `/api/v1/tokens`
   * request, which under modest concurrent load (dashboard + MCP poll)
   * could exhaust the default Pg connection pool. One `DISTINCT ON`
   * query collapses the fanout to a single round-trip.
   */
  findLatestSnapshotsByTickers(
    tickers: readonly string[],
  ): Promise<Map<string, OracleSnapshotRead>>;

  /**
   * Range-filtered chart series. Returns the points sorted by `date`
   * ascending. Empty array when no series matches.
   */
  findTimeseries(query: OracleTimeseriesQuery): Promise<OracleTimeseriesReadPoint[]>;
}
