import type { OracleAssetWrite } from '../model/oracle-payload.js';

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
}
