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
  findByIssuerUserId(
    issuerUserId: string,
    opts?: { status?: CheckoutSessionStatus; limit?: number },
  ): Promise<CheckoutSession[]>;
}
