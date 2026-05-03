/**
 * Phase 9.A · Option Z (Option C single-source) — `/activity` reads from
 * `tax_events` exclusively. Wave 3 yield + escrow paths are retired post-
 * `earlybot` merge; existing yield/escrow rows remain in DB but are no
 * longer surfaced to the feed.
 *
 * Encrypted amounts stay encrypted: every row's `amount` is `null`. The
 * frontend pulls the encrypted handle from `metadata.encrypted_amount_handle`
 * (Wrap/Unwrap rows + yield-claim rows post-2026-05-03 audit-handle
 * upgrade — closes the cumulative `_balances[investor]` chain-depth issue
 * by giving investors a fresh, indexable handle for each claim's amount;
 * see `project_cofhe_tn_chain_length_cap`) and decrypts via permit on click.
 */

import type { ITaxEventRepository } from '../../../domain/tax-event/repository/tax-event.repository.js';
import type { TaxEvent, TaxEventType } from '../../../domain/tax-event/model/tax-event.js';
import type { IUserRepository } from '../../../domain/auth/repository/user.repository.js';

export type ActivityItemType =
  | 'buy'
  | 'sell'
  | 'sell-queued'
  | 'yield'
  | 'wrap'
  | 'unwrap'
  | 'fee'
  // Phase 9.A · Option Z follow-up — P2P share transfers. The indexer
  // emits two `tax_events` rows per qualifying event (sender + recipient,
  // distinguished by `metadata.direction`); the use-case maps each row
  // to its perspective.
  | 'transfer-out'
  | 'transfer-in';

export interface ActivityItemDto {
  id: string;
  type: ActivityItemType;
  status: 'confirmed' | 'queued' | 'claimed' | 'pending';
  token_address: string | null;
  amount: string | null; // always null — values stay encrypted
  timestamp: string;
  tx_hash: string;
  /**
   * Event-specific reference id from the originating chain event. For
   * yield rows this is the `epochId` — the frontend uses it to resolve
   * the YieldSnapshot epoch for decoupled-decrypt (encRatio + snapshot
   * balance). For redemption rows it's the queue request id. Null for
   * events without a natural reference (wrap, transfer, fee).
   */
  reference_id: string | null;
  metadata?: Record<string, unknown> | null;
}

export class GetActivityUseCase {
  constructor(
    private readonly taxEventRepo: ITaxEventRepository,
    private readonly userRepo: IUserRepository,
  ) {}

  async execute(
    userId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ items: ActivityItemDto[]; has_more: boolean }> {
    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;
    const fetchLimit = limit + offset + 1;

    // tax_events is keyed by `holder_address` (kernel address), but the
    // `userId` carried by JWT claims is the application-level user id. Map
    // through the user repo first; bail with an empty page if the user has
    // no kernel address recorded yet.
    const user = await this.userRepo.findById(userId);
    const holder = user?.walletAddress;
    if (!holder) {
      return { items: [], has_more: false };
    }

    const events = await this.taxEventRepo.findByHolder(holder, fetchLimit);

    const items: ActivityItemDto[] = events.map(toActivityItem);

    const paged = items.slice(offset, offset + limit);
    const hasMore = items.length > offset + limit;

    return { items: paged, has_more: hasMore };
  }
}

function toActivityItem(e: TaxEvent): ActivityItemDto {
  return {
    id: `${e.txHash}:${e.logIndex}`,
    type: mapType(e.eventType, e.metadata),
    status: deriveStatus(e.eventType, e.metadata),
    token_address: e.tokenAddress,
    amount: null,
    timestamp: e.blockTimestamp.toISOString(),
    tx_hash: e.txHash,
    reference_id: e.referenceId,
    metadata: e.metadata ?? null,
  };
}

function mapType(t: TaxEventType, metadata: Record<string, unknown> | null): ActivityItemType {
  switch (t) {
    case 'Acquisition':
      return 'buy';
    case 'Disposition':
      // Indexer writes `kind`:
      //   'instant'             → Subscription.Redeemed (in-cap)
      //   'escalated_to_queue'  → Subscription.Redeemed (auto-escalated)
      //   'queued'              → RedemptionQueue.QueueClaimed (settled)
      // First two are "sell that ended up in the queue"; the third is the
      // queue settlement itself. Both render as `sell-queued` so the user
      // sees a queued-pill instead of a confirmed-pill.
      return metadata?.kind === 'queued' || metadata?.kind === 'escalated_to_queue'
        ? 'sell-queued'
        : 'sell';
    case 'IncomeAccrual':
      return 'yield';
    case 'Wrap':
      return 'wrap';
    case 'Unwrap':
      return 'unwrap';
    case 'Transfer':
      // Indexer writes `direction`: 'outbound' (sender's row) or
      // 'inbound' (recipient's row). Both rows share `(tx_hash,
      // log_index)` and are distinguished by `holder_address` (PK).
      return metadata?.direction === 'inbound' ? 'transfer-in' : 'transfer-out';
    case 'FeeEvent':
      return 'fee';
  }
}

function deriveStatus(
  t: TaxEventType,
  metadata: Record<string, unknown> | null,
): ActivityItemDto['status'] {
  if (
    t === 'Disposition' &&
    (metadata?.kind === 'queued' || metadata?.kind === 'escalated_to_queue')
  ) {
    return 'queued';
  }
  // Everything else surfaces as confirmed: indexer only writes after the
  // log is finalised, so the on-chain side is settled by the time the row
  // exists. Queued sells are the lone exception — the disposition log
  // confirms the queue submission, but the cash payout is still pending
  // epoch processing.
  return 'confirmed';
}
