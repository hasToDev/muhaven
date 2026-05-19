import type {
  OracleMetadataUpsert,
  OracleSnapshotUpsert,
  OracleTimeseriesPoint,
} from '../model/oracle-payload.js';

export interface IOracleRepository {
  upsertMetadata(input: OracleMetadataUpsert): Promise<void>;
  insertSnapshot(input: OracleSnapshotUpsert): Promise<void>;
  /**
   * Idempotent bulk upsert over the composite PK (ticker, measure_slug,
   * date). Caller batches the points across measures for a single
   * token; the repo flushes in chunks sized to stay under PG's bind-
   * param ceiling (currently 2,000-row chunks).
   */
  upsertTimeseries(points: OracleTimeseriesPoint[]): Promise<void>;
}
