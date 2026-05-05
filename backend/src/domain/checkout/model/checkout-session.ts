/**
 * Hosted-checkout session (Wave 4 P5).
 *
 * A session is a Stripe-style record describing a single buyer-facing
 * payment flow. Issuers create sessions via API; buyers complete them
 * via the static page hosted at `pay.muhaven.app/c/<sessionId>#k=<key>`.
 *
 * The buyer's URL fragment carries a 32-byte AES-256-GCM symmetric key
 * that decrypts the session's encrypted payload. The fragment never
 * traverses the wire, so the backend cannot decrypt the payload after
 * issue — privacy boundary intentionally limited to "ciphertext at rest +
 * fragment-key on the buyer's device". This mirrors NullPay's mental
 * model and means a leaked DB dump alone yields no plaintext amounts.
 *
 * The cleartext metadata stored on the row (issuer, token symbol, status,
 * timestamps) is what powers the API + the SSE channel; the encrypted
 * payload is opaque blob the page decrypts client-side to render the
 * buyer's checkout view.
 *
 * Lifecycle:
 *   pending → funded → wrapped → purchased → settled
 *           ↘ expired
 *           ↘ failed
 *
 * Status only flips forward; concurrent transitions resolve via
 * conditional UPDATE in the repo (Wave 5 promotes the application
 * invariant to a Postgres CHECK constraint).
 */

export const CheckoutSessionStatus = {
  /** Issuer minted the session; buyer hasn't loaded the page yet. */
  Pending: 'pending',
  /** Buyer's kernel address has at least `amountUsd6` of USDC. */
  Funded: 'funded',
  /** Wrap tx confirmed — buyer holds confidential PUSDC equivalent. */
  Wrapped: 'wrapped',
  /** Buy / `Subscription.purchase` tx confirmed on-chain. */
  Purchased: 'purchased',
  /** Backend confirmed the issuer received the deposit + buyer received the share. */
  Settled: 'settled',
  /** TTL elapsed without reaching `settled`. */
  Expired: 'expired',
  /** Buyer / chain reported a non-recoverable failure. */
  Failed: 'failed',
} as const;

export type CheckoutSessionStatus =
  (typeof CheckoutSessionStatus)[keyof typeof CheckoutSessionStatus];

export const CHECKOUT_SESSION_STATUS_VALUES: readonly CheckoutSessionStatus[] = [
  CheckoutSessionStatus.Pending,
  CheckoutSessionStatus.Funded,
  CheckoutSessionStatus.Wrapped,
  CheckoutSessionStatus.Purchased,
  CheckoutSessionStatus.Settled,
  CheckoutSessionStatus.Expired,
  CheckoutSessionStatus.Failed,
] as const;

/**
 * Status flips that the buyer-driven `transition` endpoint will accept.
 * `expired` is set by the sweeper; `failed` is reachable from any pre-
 * settled state. `settled` is gated behind backend on-chain verification
 * — the buyer's transition request only moves to `purchased`.
 */
const FORWARD_TRANSITIONS: Record<CheckoutSessionStatus, readonly CheckoutSessionStatus[]> = {
  [CheckoutSessionStatus.Pending]: [
    CheckoutSessionStatus.Funded,
    CheckoutSessionStatus.Failed,
  ],
  [CheckoutSessionStatus.Funded]: [
    CheckoutSessionStatus.Wrapped,
    CheckoutSessionStatus.Failed,
  ],
  [CheckoutSessionStatus.Wrapped]: [
    CheckoutSessionStatus.Purchased,
    CheckoutSessionStatus.Failed,
  ],
  [CheckoutSessionStatus.Purchased]: [
    CheckoutSessionStatus.Settled,
    CheckoutSessionStatus.Failed,
  ],
  [CheckoutSessionStatus.Settled]: [],
  [CheckoutSessionStatus.Expired]: [],
  [CheckoutSessionStatus.Failed]: [],
};

export function isForwardTransition(
  from: CheckoutSessionStatus,
  to: CheckoutSessionStatus,
): boolean {
  return FORWARD_TRANSITIONS[from].includes(to);
}

/**
 * Cleartext session metadata. NEVER stores the buyer-facing amount or
 * any cleartext that the privacy boundary should hide — those live in
 * `encPayload`.
 */
export interface CheckoutSessionMetadata {
  /** Issuer wallet that minted the session. */
  issuerAddress: `0x${string}`;
  /** Token contract the buyer is purchasing. */
  tokenAddress: `0x${string}`;
  /** Token symbol — surfaced on the page header as a non-sensitive label. */
  tokenSymbol: string;
  /** Issuer-supplied label resolved against ONCHAINID at create time. */
  issuerLabel: string | null;
  /** Issuer-supplied free-form free-form description (≤280 chars). */
  description: string;
  /** Optional return / cancel URLs the buyer is redirected to post-flow. */
  successUrl: string | null;
  cancelUrl: string | null;
}

export interface CheckoutSessionProps {
  sessionId: string;
  /** Issuer who minted the session — `users.id` of an issuer-role row. */
  issuerUserId: string;
  status: CheckoutSessionStatus;
  metadata: CheckoutSessionMetadata;
  /** Buyer's resolved kernel address — null until the page links one. */
  buyerAddress: `0x${string}` | null;
  /**
   * AES-256-GCM ciphertext of the encrypted payload (amount + nonce + memo).
   * The decryption key lives in the URL fragment on the buyer's device.
   * Stored as base64url; the auth tag + IV travel together with the
   * ciphertext per `encrypt-payload` ADR; see infrastructure/aes-gcm.ts.
   */
  encPayload: string;
  /**
   * On-chain UserOp hash for the `Subscription.purchase` step — null
   * until the buyer completes the purchase. NOT the wrap UserOp; the
   * wrap step is observed by the backend via tax-event indexer.
   */
  purchaseTxHash: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export class CheckoutSession implements CheckoutSessionProps {
  readonly sessionId: string;
  readonly issuerUserId: string;
  readonly status: CheckoutSessionStatus;
  readonly metadata: CheckoutSessionMetadata;
  readonly buyerAddress: `0x${string}` | null;
  readonly encPayload: string;
  readonly purchaseTxHash: string | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;

  constructor(props: CheckoutSessionProps) {
    this.sessionId = props.sessionId;
    this.issuerUserId = props.issuerUserId;
    this.status = props.status;
    this.metadata = props.metadata;
    this.buyerAddress = props.buyerAddress;
    this.encPayload = props.encPayload;
    this.purchaseTxHash = props.purchaseTxHash;
    this.expiresAt = props.expiresAt;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  isExpired(now: Date = new Date()): boolean {
    return now.getTime() >= this.expiresAt.getTime();
  }

  isTerminal(): boolean {
    return (
      this.status === CheckoutSessionStatus.Settled ||
      this.status === CheckoutSessionStatus.Expired ||
      this.status === CheckoutSessionStatus.Failed
    );
  }
}

/**
 * Session id format: `cs_<26-char alphabet>` — same Crockford-style
 * alphabet as OpenClaw intent ids (~127 bits entropy from 26 chars over
 * 30 symbols). `cs_` matches Stripe's `cs_test_…` shape so audit-log
 * grep is unambiguous.
 */
export const CHECKOUT_SESSION_ID_PREFIX = 'cs_';
export const CHECKOUT_SESSION_ID_RE = /^cs_[A-Z0-9]{26}$/;
