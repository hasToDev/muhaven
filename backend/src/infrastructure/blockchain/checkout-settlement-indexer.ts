/**
 * Wave 5 buyer-side port (P4) — `CheckoutSettlementIndexer`.
 *
 * Polls `MuHavenSubscription.Purchased` events on the configured
 * Subscription proxy address. For each event whose `transactionHash`
 * matches a tracked checkout session's `purchase_tx_hash` (set when
 * the buyer fires `transition({newStatus:'purchased'})` from the
 * buyer page after the on-chain Subscription.purchase tx confirms),
 * fires the `purchased → settled` transition via
 * `SettleFromEventUseCase`.
 *
 * Mirrors the `TaxEventIndexer` / `BlockchainEventPoller` shape:
 *  - In-memory cursor (`lastProcessedBlock`). Wave 6 can add DB
 *    persistence; for now a backend restart re-scans from the
 *    current head, which is fine because every settlement we miss
 *    eventually catches the next eligible buyer's event.
 *  - 2000-block max range per `getLogs` to avoid the Arb Sepolia
 *    RPC's "block range too large" rejection.
 *  - Re-entrancy guard via `running` bool.
 *  - On error, cursor is NOT advanced — next tick retries the same
 *    window.
 *  - Most events are non-checkout (dashboard direct purchases also
 *    fire `Purchased`), so a null `findByPurchaseTxHash` result is
 *    the common case + treated as "skip, not our session."
 */

import {
  createPublicClient,
  http,
  parseAbi,
  type Address,
  type Log,
  type PublicClient,
} from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import type { SettleFromEventUseCase } from '../../application/use-case/checkout/settle-from-event.use-case.js';
import type { ICheckoutSessionRepository } from '../../domain/checkout/repository/checkout-session.repository.js';
import { getLogger } from '../../core/logger.js';
import type { Logger } from 'pino';

const MAX_BLOCK_RANGE = 2000n;

/**
 * Subscription.Purchased event ABI — minimal, just the one event we
 * need. Inlined here so the indexer doesn't pull in the full SDK ABI
 * via the backend (the SDK has been built for client-side use; the
 * backend prefers `parseAbi` for cross-package independence).
 */
const PURCHASED_EVENT_ABI = parseAbi([
  'event Purchased(address indexed token, address indexed investor, uint128 maxSharesHint)',
] as const);

export interface CheckoutSettlementIndexerConfig {
  rpcUrl: string;
  subscriptionAddress: Address;
  intervalMs: number;
}

export interface CheckoutSettlementIndexerStatus {
  running: boolean;
  lastProcessedBlock: bigint | null;
}

export class CheckoutSettlementIndexer {
  private readonly client: PublicClient;
  private readonly subscriptionAddress: Address;
  private readonly logger: Logger;
  private lastProcessedBlock: bigint | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly sessionRepo: ICheckoutSessionRepository,
    private readonly settleUseCase: SettleFromEventUseCase,
    config: CheckoutSettlementIndexerConfig,
    /**
     * Optional injected client for tests. Tests pass a mock that stubs
     * `getBlockNumber` + `getLogs`; production constructs a real one
     * against the configured RPC.
     */
    client?: PublicClient,
  ) {
    this.subscriptionAddress = config.subscriptionAddress;
    this.client =
      client ??
      (createPublicClient({
        chain: arbitrumSepolia,
        transport: http(config.rpcUrl),
      }) as unknown as PublicClient);
    this.logger = getLogger().child({ poller: 'checkout-settlement' });
  }

  start(intervalMs: number): void {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(() => {
      void this.tick();
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  getStatus(): CheckoutSettlementIndexerStatus {
    return {
      running: this.running,
      lastProcessedBlock: this.lastProcessedBlock,
    };
  }

  /**
   * Test seam — run a single poll cycle synchronously. Used by the
   * vitest fixture to exercise the indexer without `setInterval`
   * timing assumptions.
   */
  async tickOnce(): Promise<void> {
    return this.tick();
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const currentBlock = await this.client.getBlockNumber();
      if (this.lastProcessedBlock === null) {
        // First tick — set cursor to the current head. We don't back-
        // index history because (a) any checkout sessions older than
        // this restart should already be in `settled` from the prior
        // run, and (b) re-running the use-case is idempotent so a
        // missed event eventually self-heals on the next eligible
        // purchase (which is the common case in testnet demos).
        this.lastProcessedBlock = currentBlock;
        return;
      }
      const fromBlock = this.lastProcessedBlock + 1n;
      if (fromBlock > currentBlock) return;
      const toBlock =
        currentBlock - fromBlock + 1n > MAX_BLOCK_RANGE
          ? fromBlock + MAX_BLOCK_RANGE - 1n
          : currentBlock;

      const logs = await this.client.getLogs({
        address: this.subscriptionAddress,
        events: PURCHASED_EVENT_ABI,
        fromBlock,
        toBlock,
      });

      // Post-review fix (Finding #7) — clamp the cursor when a session
      // returns from the use-case in the race-window state ("indexer
      // saw the on-chain Purchased event BEFORE the buyer's HTTP
      // `transition({newStatus:'purchased'})` POST lands"). If we
      // advance the cursor past the failing log's block, we'll never
      // see it again and the session is stranded in `funded`/`wrapped`
      // forever. The clamp finds the lowest block among retry-needed
      // logs and stops the cursor at `clampBlock - 1n` so the next
      // tick re-scans from that block onward.
      let clampBlock: bigint | null = null;
      for (const log of logs) {
        const retryNeeded = await this.processLog(log);
        if (retryNeeded && log.blockNumber !== null) {
          const lb = log.blockNumber;
          if (clampBlock === null || lb < clampBlock) {
            clampBlock = lb;
          }
        }
      }

      // Advance cursor — clamped to the lowest retry-needed block - 1.
      // If no retries needed, the full `toBlock` is consumed.
      const nextCursor = clampBlock !== null ? clampBlock - 1n : toBlock;
      // Defensive: never move the cursor backward across ticks, even
      // if a re-scan window's clampBlock somehow lands earlier than
      // the existing cursor (shouldn't happen given fromBlock = cursor
      // + 1, but the guard is cheap).
      if (this.lastProcessedBlock === null || nextCursor > this.lastProcessedBlock) {
        this.lastProcessedBlock = nextCursor;
      }
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'checkout-settlement indexer tick failed',
      );
      // Don't advance the cursor — retry the same window next tick.
    } finally {
      this.running = false;
    }
  }

  /**
   * Process a single log. Returns `true` if the log needs to be
   * retried on a future tick (race-window: indexer beat the buyer's
   * HTTP transition POST). Returns `false` if the log was handled
   * (settled, already terminal, or no matching session).
   */
  private async processLog(log: Log): Promise<boolean> {
    const txHash = log.transactionHash;
    if (!txHash) {
      // Pending logs (from `getLogs` against a `pending` block) have
      // no tx hash. Skip — we'll see them again when they're mined.
      return false;
    }
    const session = await this.sessionRepo.findByPurchaseTxHash(txHash);
    if (!session) {
      // Most events are not our sessions (dashboard direct purchases
      // also emit `Purchased`). Skip silently.
      return false;
    }
    try {
      const result = await this.settleUseCase.execute({
        session,
        blockNumber: log.blockNumber ? Number(log.blockNumber) : undefined,
      });
      if (result.transitioned) {
        this.logger.info(
          {
            sessionId: session.sessionId,
            txHash,
            blockNumber: log.blockNumber?.toString(),
          },
          'checkout session settled from on-chain event',
        );
        return false;
      }
      // `transitioned: false` covers two distinct cases:
      //  (a) Already terminal (Settled/Failed) — done, never retry.
      //  (b) Race window: session is still in funded/wrapped/pending.
      //      The buyer's `transition({purchased})` POST hasn't landed
      //      yet (or never will, if their kernel died mid-ceremony).
      //      Clamp cursor so the next tick re-checks.
      const status = result.session.status;
      const isRaceWindow =
        status !== 'settled' &&
        status !== 'failed' &&
        status !== 'expired' &&
        status !== 'purchased';
      return isRaceWindow;
    } catch (err) {
      this.logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          sessionId: session.sessionId,
          txHash,
        },
        'failed to settle checkout session from on-chain event',
      );
      // Throws are transient (DB blip, etc.) — retry on next tick.
      return true;
    }
  }
}
