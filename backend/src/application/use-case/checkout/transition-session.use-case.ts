import { ApplicationHttpError } from '../../../core/errors.js';
import {
  CheckoutSession,
  CheckoutSessionStatus,
  isForwardTransition,
} from '../../../domain/checkout/model/checkout-session.js';
import type { ICheckoutSessionRepository } from '../../../domain/checkout/repository/checkout-session.repository.js';
import {
  WebhookEventType,
  type WebhookEventType as WebhookEventTypeT,
} from '../../../domain/checkout/model/webhook-endpoint.js';
import type { WebhookDispatcher } from '../../../infrastructure/checkout/webhook-dispatcher.js';
import type { SseChannelService } from '../../../infrastructure/checkout/sse-channel.js';

/**
 * Transition a checkout session forward (Wave 4 P5).
 *
 * The buyer page calls this when it observes an on-chain or local-state
 * change (kernel funded, wrap confirmed, purchase confirmed). The
 * backend is responsible for verifying the claim BEFORE flipping —
 * Wave 4 ships a trust-the-page transition (the page only knows what
 * the buyer's kernel reports), with on-chain verification deferred to
 * the Wave-5 settlement step (`Settled` is reached only via backend
 * indexer, never via the buyer's claim).
 *
 * Concurrency: conditional UPDATE on (sessionId, expectedStatus) means
 * a stale claim never wins. Two pages racing on the same session see
 * one win, the other gets a `null` row from the repo (translated to
 * `409 Conflict` by the route).
 *
 * Side effects on a successful transition:
 *  - Publish to the SSE channel for any active subscribers.
 *  - Dispatch the matching webhook event to active issuer endpoints.
 *
 * The dispatcher is injected so tests + dev-server can wire a stub
 * without coupling this use case to fetch / Postgres directly.
 */

const STATUS_TO_EVENT: Partial<Record<CheckoutSessionStatus, WebhookEventTypeT>> = {
  [CheckoutSessionStatus.Funded]: WebhookEventType.SessionFunded,
  [CheckoutSessionStatus.Wrapped]: WebhookEventType.SessionWrapped,
  [CheckoutSessionStatus.Purchased]: WebhookEventType.SessionPurchased,
  [CheckoutSessionStatus.Settled]: WebhookEventType.SessionSettled,
  [CheckoutSessionStatus.Expired]: WebhookEventType.SessionExpired,
  [CheckoutSessionStatus.Failed]: WebhookEventType.SessionFailed,
};

export interface TransitionCheckoutSessionInput {
  sessionId: string;
  newStatus: CheckoutSessionStatus;
  /** Captured when the buyer first reaches Funded. */
  buyerAddress?: `0x${string}`;
  /** Captured on the Purchased step. */
  purchaseTxHash?: string;
  now?: Date;
}

export interface TransitionCheckoutSessionResult {
  session: CheckoutSession;
}

export class TransitionCheckoutSessionUseCase {
  constructor(
    private readonly sessionRepo: ICheckoutSessionRepository,
    private readonly sseChannel: SseChannelService,
    private readonly webhookDispatcher: WebhookDispatcher | null,
  ) {}

  async execute(
    input: TransitionCheckoutSessionInput,
  ): Promise<TransitionCheckoutSessionResult> {
    if (
      input.newStatus === CheckoutSessionStatus.Settled ||
      input.newStatus === CheckoutSessionStatus.Failed
    ) {
      // Settled is reachable only from backend-side verification (chain
      // indexer). Failed is reserved for backend-side fault detection
      // — buyer-driven Failed would let any URL-holder freeze the
      // session out of the funded/wrapped lane. Buyer-side wrap/buy
      // errors surface in the page UI without state mutation.
      throw ApplicationHttpError.forbidden(
        `${input.newStatus} status is reserved for backend confirmation`,
      );
    }

    const now = input.now ?? new Date();
    const existing = await this.sessionRepo.findById(input.sessionId);
    if (!existing) {
      throw ApplicationHttpError.notFound('checkout session not found');
    }
    if (existing.isTerminal()) {
      throw ApplicationHttpError.conflict(
        `session is in terminal state: ${existing.status}`,
      );
    }
    // TTL only gates `pending` sessions — once funded/wrapped/purchased
    // the deal is in motion and the chain decides timing. Concurrent
    // sweeps that flip pending → expired are caught by the conditional
    // UPDATE in the repo (returns null on stale guard).
    if (
      existing.status === CheckoutSessionStatus.Pending &&
      existing.isExpired(now)
    ) {
      throw ApplicationHttpError.conflict('session has expired');
    }
    if (!isForwardTransition(existing.status, input.newStatus)) {
      throw ApplicationHttpError.conflict(
        `invalid transition ${existing.status} → ${input.newStatus}`,
      );
    }
    if (
      input.newStatus === CheckoutSessionStatus.Purchased &&
      !input.purchaseTxHash
    ) {
      throw ApplicationHttpError.badRequest(
        'purchaseTxHash required for purchased transition',
      );
    }
    if (
      input.newStatus === CheckoutSessionStatus.Funded &&
      !input.buyerAddress &&
      !existing.buyerAddress
    ) {
      throw ApplicationHttpError.badRequest(
        'buyerAddress required for funded transition',
      );
    }

    const transitioned = await this.sessionRepo.transition({
      sessionId: input.sessionId,
      expectedStatus: existing.status,
      newStatus: input.newStatus,
      ...(input.purchaseTxHash ? { purchaseTxHash: input.purchaseTxHash } : {}),
      ...(input.buyerAddress ? { buyerAddress: input.buyerAddress } : {}),
      now,
    });
    if (!transitioned) {
      throw ApplicationHttpError.conflict(
        'concurrent transition won; refresh and retry',
      );
    }

    // Side effects — best-effort fire after the row is persisted.
    this.sseChannel.publish({
      type: input.newStatus,
      sessionId: input.sessionId,
      data: {
        status: transitioned.status,
        buyerAddress: transitioned.buyerAddress,
        purchaseTxHash: transitioned.purchaseTxHash,
        updatedAt: transitioned.updatedAt.toISOString(),
      },
    });
    if (transitioned.isTerminal()) {
      this.sseChannel.closeSession(input.sessionId);
    }

    const eventType = STATUS_TO_EVENT[input.newStatus];
    if (eventType && this.webhookDispatcher) {
      await this.webhookDispatcher.dispatch({
        eventType,
        sessionId: input.sessionId,
        issuerUserId: transitioned.issuerUserId,
        payload: {
          status: transitioned.status,
          tokenAddress: transitioned.metadata.tokenAddress,
          tokenSymbol: transitioned.metadata.tokenSymbol,
          buyerAddress: transitioned.buyerAddress,
          purchaseTxHash: transitioned.purchaseTxHash,
          createdAt: transitioned.createdAt.toISOString(),
          updatedAt: transitioned.updatedAt.toISOString(),
        },
        now,
      });
    }

    return { session: transitioned };
  }
}
