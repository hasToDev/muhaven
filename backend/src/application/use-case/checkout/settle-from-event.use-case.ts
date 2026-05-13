/**
 * Wave 5 buyer-side port (P4) — backend-side `purchased → settled`
 * transition triggered by the `CheckoutSettlementIndexer` after it
 * observes a `MuHavenSubscription.Purchased` log whose
 * `transactionHash` matches a tracked session's `purchase_tx_hash`.
 *
 * Separate use-case from `TransitionCheckoutSessionUseCase` because:
 *  - That use-case explicitly REJECTS `Settled` (line 72-84): the
 *    buyer-driven HTTP transition endpoint must never allow the
 *    buyer to flip a session to a terminal state — that's reserved
 *    for backend chain verification.
 *  - This use-case is the ONLY caller authorised to fire `Settled`.
 *    Only the indexer should construct it (wired in container.ts +
 *    bootstrapped in dev-server.ts).
 *
 * Idempotent: if the session is already `Settled` (e.g., a duplicate
 * event from a chain re-org or a repeated poll cycle), returns the
 * existing row without firing the side effects again. The repo's
 * conditional UPDATE handles the race window between the read and
 * the write.
 *
 * Side effects (matched to the buyer-driven use-case):
 *  - Publish SSE event so any open buyer-page tab sees the final
 *    "Settled" status without a page reload.
 *  - Close the SSE channel for the session (terminal state).
 *  - Dispatch the `SessionSettled` webhook to all registered issuer
 *    endpoints for the issuer who owns this session.
 */

import { ApplicationHttpError } from '../../../core/errors.js';
import {
  CheckoutSession,
  CheckoutSessionStatus,
} from '../../../domain/checkout/model/checkout-session.js';
import type { ICheckoutSessionRepository } from '../../../domain/checkout/repository/checkout-session.repository.js';
import type { SseChannelService } from '../../../infrastructure/checkout/sse-channel.js';
import type { WebhookDispatcher } from '../../../infrastructure/checkout/webhook-dispatcher.js';
import { WebhookEventType } from '../../../domain/checkout/model/webhook-endpoint.js';

export interface SettleFromEventInput {
  /** Domain-level checkout session previously found by the indexer
   *  via `repo.findByPurchaseTxHash(log.transactionHash)`. The indexer
   *  passes the row in (rather than re-looking-up) so the indexer's
   *  filter logic stays the canonical source of "is this our event?". */
  session: CheckoutSession;
  /** Block number of the observed log — recorded as part of the
   *  side-effect payload so issuer webhooks can correlate. */
  blockNumber?: number;
  now?: Date;
}

export interface SettleFromEventResult {
  /** The (potentially already-settled) session row post-transition. */
  session: CheckoutSession;
  /** `false` when the indexer beat us with an earlier event in the
   *  same batch, the session was already terminal at look-up time, or
   *  another concurrent caller already settled. */
  transitioned: boolean;
}

export class SettleFromEventUseCase {
  constructor(
    private readonly sessionRepo: ICheckoutSessionRepository,
    private readonly sseChannel: SseChannelService,
    private readonly webhookDispatcher: WebhookDispatcher | null,
  ) {}

  async execute(input: SettleFromEventInput): Promise<SettleFromEventResult> {
    const now = input.now ?? new Date();
    // Defensive re-check: the indexer found this row a moment ago, but
    // the use-case is on a separate transaction. Take the latest row
    // and bail if it's already terminal — idempotent for re-orgs.
    const fresh = await this.sessionRepo.findById(input.session.sessionId);
    if (!fresh) {
      // Session was hard-deleted between indexer dispatch and now —
      // shouldn't happen given the audit policy in repo.ts, but the
      // null-guard keeps the indexer's loop crash-free.
      throw ApplicationHttpError.notFound(
        `checkout session not found: ${input.session.sessionId}`,
      );
    }
    if (fresh.status === CheckoutSessionStatus.Settled) {
      // Already settled — return the row as-is, no side effects.
      return { session: fresh, transitioned: false };
    }
    if (fresh.isTerminal()) {
      // Some other terminal state (Failed / Expired). Don't override
      // — the indexer's record of "we saw a Purchased event for this
      // tx" doesn't outrank a Failed flip from elsewhere.
      return { session: fresh, transitioned: false };
    }
    if (fresh.status !== CheckoutSessionStatus.Purchased) {
      // Indexer saw the on-chain Purchased event, but the session is
      // not in 'purchased' state. This is a race window: the buyer's
      // HTTP `transition({newStatus: 'purchased'})` POST may be
      // pending. Bail — the next poll cycle will retry, and the row
      // will be in `purchased` by then.
      return { session: fresh, transitioned: false };
    }

    const transitioned = await this.sessionRepo.transition({
      sessionId: fresh.sessionId,
      expectedStatus: CheckoutSessionStatus.Purchased,
      newStatus: CheckoutSessionStatus.Settled,
      now,
    });
    if (!transitioned) {
      // Conditional UPDATE failed — another caller flipped the row
      // first. Treat as "someone settled it" + report the latest.
      const latest =
        (await this.sessionRepo.findById(fresh.sessionId)) ?? fresh;
      return { session: latest, transitioned: false };
    }

    // Side effects — fire after the row is persisted. Same shape as
    // `TransitionCheckoutSessionUseCase`.
    this.sseChannel.publish({
      type: CheckoutSessionStatus.Settled,
      sessionId: transitioned.sessionId,
      data: {
        status: transitioned.status,
        buyerAddress: transitioned.buyerAddress,
        purchaseTxHash: transitioned.purchaseTxHash,
        updatedAt: transitioned.updatedAt.toISOString(),
        ...(input.blockNumber !== undefined
          ? { blockNumber: input.blockNumber }
          : {}),
      },
    });
    this.sseChannel.closeSession(transitioned.sessionId);

    if (this.webhookDispatcher) {
      await this.webhookDispatcher.dispatch({
        eventType: WebhookEventType.SessionSettled,
        sessionId: transitioned.sessionId,
        issuerUserId: transitioned.issuerUserId,
        payload: {
          status: transitioned.status,
          tokenAddress: transitioned.metadata.tokenAddress,
          tokenSymbol: transitioned.metadata.tokenSymbol,
          buyerAddress: transitioned.buyerAddress,
          purchaseTxHash: transitioned.purchaseTxHash,
          ...(input.blockNumber !== undefined
            ? { blockNumber: input.blockNumber }
            : {}),
        },
      });
    }

    return { session: transitioned, transitioned: true };
  }
}
