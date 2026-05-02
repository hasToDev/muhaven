/**
 * TokenRegistryHandler — Phase 9.A · Expansion (F1) — block-poller
 * collaborator for `TokenRegistry` events.
 *
 * Lives next to `TaxEventIndexer` (rather than inside it) so a future
 * `MultiplexedRegistryIndexer` extraction is a straight lift-and-shift:
 * the indexer knows how to fetch logs for an address-set, but the
 * dispatch + repo write for each registry event lives here.
 *
 * Today it handles only `IssuerUpdated` — `TokenRegistry` also emits
 * `PausedUpdated`, `MinInvestmentUpdated`, `InstantRedeemCapUpdated`,
 * `EpochDurationUpdated`, but those have no DB column to mutate today.
 * Add a method here + an entry to `tokenRegistryEventsAbi` when a
 * downstream column lands.
 *
 * Failure posture: any repo write error must propagate to the caller so
 * `TaxEventIndexer.tick()` catches it and refuses to advance the
 * cursor. Re-running the same tick replays the log; the repo update is
 * idempotent (UPDATE … WHERE → 0 or 1 rows mutated, no thrash).
 */
import type { Address, Log } from 'viem';
import type { IRwaTokenRepository } from '../../domain/token-registry/repository/rwa-token.repository.js';
import { getLogger } from '../../core/logger.js';
import type { Logger } from 'pino';

export class TokenRegistryHandler {
  private readonly logger: Logger;

  constructor(private readonly rwaTokenRepo: IRwaTokenRepository) {
    this.logger = getLogger('TokenRegistryHandler');
  }

  /**
   * Handle a single decoded `IssuerUpdated(token, oldIssuer, newIssuer)`
   * log. Returns silently when the log is missing required fields
   * (defensive — viem's decoder shouldn't produce these but the indexer
   * fans logs across many event types).
   *
   * Throws on repo errors — the caller must let the throw propagate to
   * `TaxEventIndexer.tick()`'s catch so the cursor isn't advanced on a
   * failed write.
   */
  async applyIssuerUpdated(log: Log): Promise<void> {
    const eventName = (log as Log & { eventName?: string }).eventName;
    const args = (log as Log & { args?: Record<string, unknown> }).args;
    if (eventName !== 'IssuerUpdated' || !args) return;

    const token = args.token as Address | undefined;
    const oldIssuer = args.oldIssuer as Address | undefined;
    const newIssuer = args.newIssuer as Address | undefined;
    if (!token || !newIssuer) {
      this.logger.warn({ log }, 'IssuerUpdated missing token / newIssuer');
      return;
    }

    await this.rwaTokenRepo.updateIssuer(token, newIssuer);
    this.logger.info(
      {
        token,
        oldIssuer: oldIssuer ?? null,
        newIssuer,
        txHash: log.transactionHash ?? null,
      },
      'Applied IssuerUpdated rotation',
    );
  }
}
