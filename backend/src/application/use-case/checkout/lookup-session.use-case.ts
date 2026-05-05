import { ApplicationHttpError } from '../../../core/errors.js';
import {
  CheckoutSession,
  CheckoutSessionStatus,
} from '../../../domain/checkout/model/checkout-session.js';
import type { ICheckoutSessionRepository } from '../../../domain/checkout/repository/checkout-session.repository.js';

/**
 * Lookup a hosted-checkout session by id (Wave 4 P5).
 *
 * The buyer page calls this on load with no auth (the URL itself is the
 * capability). Returns the encrypted payload + cleartext metadata; the
 * page client-side-decrypts the payload using the URL fragment key.
 *
 * Sweeps `pending` rows past `expiresAt` to `expired` lazily on every
 * lookup so the buyer page never observes a stale session.
 *
 * Privacy note: the response intentionally omits `issuerUserId` (would
 * leak the platform user-id behind the resolved issuer label, beyond
 * what `metadata.issuerLabel` already exposes). `buyerAddress` IS
 * surfaced — anyone with the sessionId can read it from this endpoint
 * AND from the SSE snapshot in `events.ts`. That is intentional in the
 * URL-as-capability model: a sessionId-only caller is already, by
 * design, "buyer-side" (only the buyer + the issuer-side dashboard
 * receive the URL). `buyerAddress` is a public on-chain identifier the
 * buyer voluntarily binds by linking; it carries no entropy beyond
 * what the chain itself reveals once they transact. The encrypted
 * payload behind `encPayload` remains gated by the URL fragment key —
 * that key never reaches the backend, so this endpoint cannot decrypt
 * the contents even for the buyer.
 */

export interface LookupCheckoutSessionInput {
  sessionId: string;
  now?: Date;
}

export interface LookupCheckoutSessionResult {
  sessionId: string;
  status: CheckoutSessionStatus;
  encPayload: string;
  metadata: CheckoutSession['metadata'];
  buyerAddress: `0x${string}` | null;
  purchaseTxHash: string | null;
  expiresAt: Date;
  createdAt: Date;
}

export class LookupCheckoutSessionUseCase {
  constructor(private readonly sessionRepo: ICheckoutSessionRepository) {}

  async execute(input: LookupCheckoutSessionInput): Promise<LookupCheckoutSessionResult> {
    const now = input.now ?? new Date();
    const session = await this.sessionRepo.findById(input.sessionId);
    if (!session) {
      throw ApplicationHttpError.notFound('checkout session not found');
    }

    let current = session;
    if (
      current.status === CheckoutSessionStatus.Pending &&
      current.isExpired(now)
    ) {
      const transitioned = await this.sessionRepo.transition({
        sessionId: input.sessionId,
        expectedStatus: CheckoutSessionStatus.Pending,
        newStatus: CheckoutSessionStatus.Expired,
        now,
      });
      if (transitioned) current = transitioned;
    }

    return {
      sessionId: current.sessionId,
      status: current.status,
      encPayload: current.encPayload,
      metadata: current.metadata,
      buyerAddress: current.buyerAddress,
      purchaseTxHash: current.purchaseTxHash,
      expiresAt: current.expiresAt,
      createdAt: current.createdAt,
    };
  }
}
