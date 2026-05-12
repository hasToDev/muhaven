import type {
  CheckoutSession,
  CheckoutSessionStatus,
} from '../model/checkout-session.js';

export interface IssueCheckoutSessionInput {
  session: CheckoutSession;
}

export interface TransitionCheckoutSessionInput {
  sessionId: string;
  /** Expected current status — atomic conditional UPDATE guards the flip. */
  expectedStatus: CheckoutSessionStatus;
  newStatus: CheckoutSessionStatus;
  /** Captured on `purchased`. */
  purchaseTxHash?: string;
  /** Captured on first buyer page load. */
  buyerAddress?: `0x${string}`;
  now: Date;
}

/**
 * Keyset cursor for paginating issuer-scoped session listings. The cursor
 * encodes the boundary row's `(createdAt, sessionId)` tuple so duplicate
 * `createdAt` ticks (realistic on a Wave-5-shaped issuer back-fill that
 * mints sessions in a tight loop) still page deterministically.
 */
export interface CheckoutSessionListCursor {
  createdAtMs: number;
  sessionId: string;
}

export interface FindIssuerSessionsOpts {
  status?: CheckoutSessionStatus;
  /** Page size — repo enforces `≤200` cap server-side; the use-case layer
   *  caps at 50 for the issuer dashboard surface. */
  limit?: number;
  /** Opaque cursor minted by the previous page's response. */
  cursor?: CheckoutSessionListCursor;
}

export interface FindIssuerSessionsResult {
  sessions: CheckoutSession[];
  /** Cursor for the NEXT page; null when this page was the tail. */
  nextCursor: CheckoutSessionListCursor | null;
}

/**
 * Per-status counts for the issuer dashboard stats card. Count-only by
 * design — the privacy boundary (encrypted `encPayload` + key-on-client)
 * makes amount aggregation structurally impossible without breaking the
 * privacy-at-rest property. See `ISSUER_CHECKOUT_DASHBOARD_PLAN.md` §1.A.
 */
export interface IssuerSessionStatsRow {
  total: number;
  byStatus: Record<CheckoutSessionStatus, number>;
}

/**
 * Per-day session counts for the trend line on the stats card. Day key is
 * an ISO date string (`YYYY-MM-DD`) in UTC; the use-case layer joins gaps
 * server-side so the chart renders a continuous range.
 */
export interface IssuerSessionDailyBucket {
  /** UTC midnight ms (matches `Date.UTC(y, m, d)` for forward compat with
   *  charting libraries that expect ms-since-epoch x-axis values). */
  bucketMs: number;
  count: number;
}

/**
 * Persistence contract for hosted-checkout sessions.
 *
 * Implementations MUST:
 *  - Enforce status transitions atomically with conditional UPDATE so
 *    only one of two concurrent transitions wins.
 *  - Treat the session log as audit material — no row deletion, only
 *    forward status flips. Wave 5 may add a hard-delete cron with a
 *    >180d retention window for GDPR.
 *  - Sweep expired pending rows lazily on every lookup.
 */
export interface ICheckoutSessionRepository {
  issue(input: IssueCheckoutSessionInput): Promise<void>;
  findById(sessionId: string): Promise<CheckoutSession | null>;
  /** Atomic status flip — returns the new row on success, null on a stale guard. */
  transition(input: TransitionCheckoutSessionInput): Promise<CheckoutSession | null>;
  /** Sweep `pending` rows past `expiresAt` to status=`expired`. Returns count. */
  sweepExpired(now: Date): Promise<number>;
  /**
   * Cursor-paginated issuer-scoped listing for the dashboard. The
   * (createdAt DESC, sessionId DESC) ordering is the canonical "newest
   * first" page sort.
   */
  findByIssuerUserId(
    issuerUserId: string,
    opts?: FindIssuerSessionsOpts,
  ): Promise<FindIssuerSessionsResult>;
  /**
   * Stats card aggregates — total + per-status counts. Range optional;
   * when omitted, aggregates over the entire history for this issuer.
   */
  countByIssuerAndStatus(
    issuerUserId: string,
    opts?: { since?: Date; until?: Date },
  ): Promise<IssuerSessionStatsRow>;
  /**
   * Per-day session creation counts for the trend chart. Returns rows
   * ONLY for days that had ≥1 session; the use-case layer fills gaps.
   */
  countByIssuerAndDay(
    issuerUserId: string,
    opts: { since: Date; until: Date },
  ): Promise<IssuerSessionDailyBucket[]>;
}
