import { randomBytes } from 'node:crypto';
import { ApplicationHttpError } from '../../../core/errors.js';
import {
  CHECKOUT_SESSION_ID_PREFIX,
  CheckoutSession,
  type CheckoutSessionMetadata,
  CheckoutSessionStatus,
} from '../../../domain/checkout/model/checkout-session.js';
import type { ICheckoutSessionRepository } from '../../../domain/checkout/repository/checkout-session.repository.js';
import type { IUserRepository } from '../../../domain/auth/repository/user.repository.js';
import {
  b64url,
  CheckoutAesGcm,
} from '../../../infrastructure/checkout/aes-gcm.js';

/**
 * Create a hosted-checkout session (Wave 4 P5).
 *
 * Flow:
 *  1. Validate inputs.
 *  2. Encrypt the buyer-facing payload with a freshly-minted 32B key.
 *  3. Persist the session row with the ciphertext (key NOT persisted).
 *  4. Return `{sessionId, fragmentKey, url}` to the issuer ONCE — the
 *     URL is what the issuer surfaces to the buyer; we cannot reconstruct
 *     the payload after this point without the fragment key.
 *
 * Privacy property: a leaked DB dump alone yields no plaintext amounts.
 * The fragment key transits only over the HTTPS connection that returns
 * this response + lives client-side in the buyer's URL bar.
 */

/** ~30 minutes — research §"Hosted checkout" + locked decisions in PROGRESS.md. */
const DEFAULT_TTL_SEC = 30 * 60;

/** Concrete cap on the encrypted payload to fit comfortably in a single
 *  DB row + URL inspection. ~4KB of plaintext fits in ~5.5KB ciphertext
 *  envelope; the cap is generous. */
const MAX_PLAINTEXT_BYTES = 4 * 1024;

export interface CreateCheckoutSessionInput {
  issuerUserId: string;
  metadata: CheckoutSessionMetadata;
  /**
   * Cleartext payload the page renders client-side. Must be a JSON-
   * serialisable structure under MAX_PLAINTEXT_BYTES.
   */
  payload: {
    /** USDC 6-decimal amount as a non-negative bigint string. */
    amountUsd6: string;
    /** Free-form memo (≤280 chars) shown on the buyer page. */
    memo?: string;
    /** Optional issuer-supplied reference id for reconciliation. */
    referenceId?: string;
  };
  /** Optional override of TTL for testing; default 30 min. */
  ttlSec?: number;
  now?: Date;
}

export interface CreateCheckoutSessionResult {
  session: CheckoutSession;
  /**
   * 32-byte fragment key, base64url-encoded. Goes into the URL hash —
   * issuers SHOULD render the URL once and forget the key (it's
   * recoverable only by re-creating the session).
   */
  fragmentKey: string;
  /** Full buyer-facing URL with fragment key embedded. */
  url: string;
}

export class CreateCheckoutSessionUseCase {
  private readonly aes = new CheckoutAesGcm();

  constructor(
    private readonly sessionRepo: ICheckoutSessionRepository,
    private readonly publicBaseUrl: string,
    private readonly userRepo: IUserRepository,
  ) {}

  async execute(input: CreateCheckoutSessionInput): Promise<CreateCheckoutSessionResult> {
    // Phase 9.A · F2 onboarding gate (port-time fix). Mirrors
    // `DeployTokenUseCase.start` — `withRole('issuer')` on the route
    // only checks the JWT's `role` claim, not the lifecycle column.
    // An issuer-roled user who hasn't completed `/apply-issuer`, or
    // whose KYB status is `pending` / `suspended`, can present a
    // valid JWT but cannot mint hosted-checkout sessions or bind
    // the platform's issuer label to a buyer-facing URL.
    const issuer = await this.userRepo.findById(input.issuerUserId);
    if (!issuer || issuer.role !== 'issuer' || issuer.issuerStatus !== 'approved') {
      throw ApplicationHttpError.forbidden(
        'Issuer onboarding required before checkout-session create',
        { code: 'NOT_APPROVED_ISSUER' },
      );
    }

    const payloadBytes = Buffer.byteLength(JSON.stringify(input.payload), 'utf-8');
    if (payloadBytes > MAX_PLAINTEXT_BYTES) {
      throw ApplicationHttpError.badRequest(
        `payload exceeds ${MAX_PLAINTEXT_BYTES}-byte cap`,
      );
    }
    // Third-pass review (Arch M-1): require positive integer (no `0`,
    // no leading zeros) so the dashboard create path matches the agent
    // path's `^[1-9]\d*$` posture. A $0 session is meaningless across
    // either surface.
    if (!/^[1-9]\d{0,17}$/.test(input.payload.amountUsd6)) {
      throw ApplicationHttpError.badRequest(
        'amountUsd6 must be a positive integer (1-18 decimal digits, no leading zeros)',
      );
    }
    // Plan B (2026-05-14 walkthrough): demo-NAV scaling on the buyer
    // page requires ≥1 USDC. Issuers previously could mint sub-$1
    // sessions; buyer page rejected with full-page error after the URL
    // was already shared. Gate at create time across both surfaces.
    if (BigInt(input.payload.amountUsd6) < 1_000_000n) {
      throw ApplicationHttpError.badRequest(
        'amountUsd6 must be ≥ 1_000_000 (1 USDC) — demo-NAV scaling rejects smaller amounts',
      );
    }
    if (input.payload.memo !== undefined && input.payload.memo.length > 280) {
      throw ApplicationHttpError.badRequest('memo must be ≤280 characters');
    }
    if (input.payload.referenceId !== undefined && input.payload.referenceId.length > 64) {
      throw ApplicationHttpError.badRequest('referenceId must be ≤64 characters');
    }

    const ttlSec = input.ttlSec ?? DEFAULT_TTL_SEC;
    if (ttlSec <= 0 || ttlSec > 24 * 60 * 60) {
      throw ApplicationHttpError.badRequest('ttlSec must be in (0, 86400]');
    }

    const now = input.now ?? new Date();
    const expiresAt = new Date(now.getTime() + ttlSec * 1000);
    const sessionId = generateSessionId();

    const { encPayload, key } = this.aes.encrypt(input.payload);
    const fragmentKey = b64url(key);

    const session = new CheckoutSession({
      sessionId,
      issuerUserId: input.issuerUserId,
      status: CheckoutSessionStatus.Pending,
      metadata: input.metadata,
      buyerAddress: null,
      encPayload,
      purchaseTxHash: null,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });

    await this.sessionRepo.issue({ session });

    const url = buildCheckoutUrl(this.publicBaseUrl, sessionId, fragmentKey);
    return { session, fragmentKey, url };
  }
}

const SESSION_ID_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

function generateSessionId(): string {
  const buf = randomBytes(26);
  let out = '';
  for (const b of buf) {
    out += SESSION_ID_ALPHABET[b % SESSION_ID_ALPHABET.length];
  }
  return CHECKOUT_SESSION_ID_PREFIX + out;
}

/**
 * Build the buyer-facing URL. Fragment is everything after `#` so it
 * never reaches the server. Format chosen to match the locked decision
 * in `PROGRESS.md` §"Phase P5":
 *
 *   https://pay.muhaven.app/c/<sessionId>#k=<base64url(32B)>
 */
export function buildCheckoutUrl(
  baseUrl: string,
  sessionId: string,
  fragmentKey: string,
): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}/c/${sessionId}#k=${fragmentKey}`;
}
