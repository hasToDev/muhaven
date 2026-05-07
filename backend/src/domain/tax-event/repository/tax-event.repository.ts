import type { TaxEvent, TaxEventType } from '../model/tax-event.js';

/**
 * Aggregate counts grouped by `event_type`. Includes every type the
 * indexer captures (Acquisition / Disposition / IncomeAccrual /
 * FeeEvent / Wrap / Unwrap / Transfer); zero-row types are returned
 * as `0` so callers don't have to guard for `undefined`.
 */
export type TaxEventCountsByType = Record<TaxEventType, number>;

/** Single bucket in a daily-counts series. `day` is an ISO date (YYYY-MM-DD). */
export interface DailyCount {
  day: string;
  count: number;
}

/** Single bucket in the per-token acquisitions tally. */
export interface AcquisitionsByToken {
  /** Lower-cased EVM address. */
  tokenAddress: string;
  count: number;
}

/** Disposition kind taxonomy (per ADR-020 redemption flow). */
export type DispositionKind = 'instant' | 'queued' | 'escalated_to_queue';

export interface DispositionKindTotals {
  instant: number;
  queued: number;
  escalatedToQueue: number;
}

export interface DispositionKindByDay {
  day: string;
  instant: number;
  queued: number;
  escalatedToQueue: number;
}

export interface DispositionsByKindResult {
  totals: DispositionKindTotals;
  byDay: DispositionKindByDay[];
}

export interface ITaxEventRepository {
  /**
   * Insert markers idempotently. The `(tx_hash, log_index)` PRIMARY KEY makes
   * duplicate events from a re-poll a no-op. Returns the count of newly-
   * persisted markers.
   */
  saveMany(events: TaxEvent[]): Promise<number>;
  findByHolder(holderAddress: string, limit: number): Promise<TaxEvent[]>;

  /**
   * Wave 4 P9 · public-metrics aggregations. All four read-only
   * methods return aggregate counts only — never per-investor or
   * cleartext amounts. Lower-case `token_address` at the SQL
   * boundary per `feedback_address_case_at_repo_boundary`.
   */
  aggregateCounts(): Promise<TaxEventCountsByType>;
  dailyCounts(eventType: TaxEventType): Promise<DailyCount[]>;
  acquisitionsByToken(): Promise<AcquisitionsByToken[]>;
  dispositionsByKind(): Promise<DispositionsByKindResult>;
}
