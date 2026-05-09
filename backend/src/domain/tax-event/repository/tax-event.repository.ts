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
   * Wave 4 follow-up — Phase 9.A `apply-issuer` guardrail. Returns true
   * if the holder has any RWA-related tax_event row (Acquisition,
   * Disposition, IncomeAccrual, FeeEvent, Transfer per
   * `INVESTOR_ACTIVITY_EVENT_TYPES`). Cash-rail events (Wrap / Unwrap
   * on MuHavenStable) are explicitly excluded — wrapping USDC into
   * mhUSDC is a payment-rail step, not investor history, and a fresh
   * user funding their first RWA buy must not be locked out of issuer
   * onboarding by it.
   *
   * Implementation hint: SELECT 1 ... LIMIT 1 + IN (...) on event_type;
   * caller only needs the boolean. Lower-case the holder at the SQL
   * boundary per `feedback_address_case_at_repo_boundary` — note that
   * wrapping `holder_address` in `lower(...)` makes the plain B-tree at
   * `tax_events_holder_address_idx` unusable, so this is a sequential
   * scan today. Acceptable for the apply-issuer one-shot path; if this
   * method ever lands on a hot path, add a functional index on
   * `lower(holder_address)` (one schema change benefits `findByHolder`
   * too).
   */
  hasInvestorActivity(holderAddress: string): Promise<boolean>;

  /**
   * Wave 4 P2 follow-up — the agent's `propose_buy` fresh-wallet gate.
   * Returns true when the holder has any cash-rail event row (Wrap /
   * Unwrap / Transfer per `CASH_RAIL_EVENT_TYPES`). Mirrors
   * `hasInvestorActivity` posture: case-insensitive WHERE, IN-list on
   * event_type, LIMIT 1.
   *
   * The agent uses `false` as a hard "definitely no mhUSDC balance"
   * signal so it can refuse propose_buy with INSUFFICIENT_MHUSDC and
   * the LLM can synthesise a "wrap first" reply. A `true` result is
   * NOT a positive balance check — the user could have wrapped 100
   * and spent 100. Backend can't read the encrypted balance directly
   * (privacy invariant); the SDK-side decrypt-and-compare lands in
   * Wave 5 alongside the cofhe permit helper.
   */
  hasCashRailActivity(holderAddress: string): Promise<boolean>;

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
