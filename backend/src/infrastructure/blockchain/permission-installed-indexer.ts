/**
 * Wave 5 Option D · Commit 3 — chain indexer for kernel V3.1
 * `PermissionInstalled(bytes4 permission, uint32 nonce)` events.
 *
 * **AUTHORITATIVE source of truth** for `agent_scoped_sessions.enable_status`
 * transitions from `'pending'` to `'enabled'`. The broker-callback route
 * exists as a fast-path optimization (MCP-server-mediated); this indexer
 * is the safety net that flips the row even when:
 *   - the broker daemon is offline
 *   - the broker's outbound HTTPS callback fails after exhausting retries
 *   - the MCP server crashes mid-flow between submit and notify
 *
 * Polling pattern mirrors `CheckoutSettlementIndexer` (2000-block window
 * max, in-memory cursor, re-entrant guard, error → no cursor advance).
 *
 * **Why poll instead of subscribe** (`eth_subscribe('logs',...)`): Arb
 * Sepolia HTTP endpoints don't reliably support websocket subscriptions
 * across providers. Polling is the consistent baseline; future WS support
 * can be added as a sibling without changing the use-case contract.
 *
 * **Filter scope**: we DO NOT filter on event-emitter address. Every
 * kernel V3.1 smart account in the system emits `PermissionInstalled`
 * from its OWN address; trying to maintain an `[allKernelAddresses]`
 * filter would require a sweep of every onboarded user. The downside is
 * a wider getLogs result set; the upside is no enumeration cost.
 * Acceptable for the hackathon scale; revisit at Slice 5+ if log volume
 * becomes a hotspot.
 */

import {
  createPublicClient,
  http,
  parseAbi,
  decodeEventLog,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import type { IScopedSessionRepository } from '../../domain/agent/repository/scoped-session.repository.js';
import type { MarkScopedSessionValidatorEnabledUseCase } from '../../application/use-case/agent/policy/mark-scoped-session-validator-enabled.use-case.js';
import { ApplicationHttpError } from '../../core/errors.js';
import { getLogger } from '../../core/logger.js';
import type { Logger } from 'pino';

const MAX_BLOCK_RANGE = 2000n;

const PERMISSION_INSTALLED_EVENT_ABI = parseAbi([
  'event PermissionInstalled(bytes4 permission, uint32 nonce)',
]);

export interface PermissionInstalledIndexerConfig {
  readonly rpcUrl: string;
  readonly intervalMs: number;
  /**
   * Wave 5 Option D Commit 3 (multi-agent review HIGH-2-BE) — block
   * confirmation buffer. Adapts `toBlock = currentBlock - confirmations`
   * so a reorged-out `PermissionInstalled` log never lands as an
   * `enable_status='enabled'` flip with a dangling tx hash. Arb
   * Sepolia reorgs are rare but possible. Default 0 (no buffer)
   * mirrors `CheckoutSettlementIndexer` for hackathon parity;
   * post-hackathon SHOULD raise to 2+.
   */
  readonly confirmations?: number;
}

export interface PermissionInstalledIndexerStatus {
  readonly running: boolean;
  readonly lastProcessedBlock: bigint | null;
}

export class PermissionInstalledIndexer {
  private readonly client: PublicClient;
  private readonly logger: Logger;
  private readonly confirmations: bigint;
  private lastProcessedBlock: bigint | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly scopedRepo: IScopedSessionRepository,
    private readonly markEnabled: MarkScopedSessionValidatorEnabledUseCase,
    config: PermissionInstalledIndexerConfig,
    client?: PublicClient,
  ) {
    this.client =
      client ??
      (createPublicClient({
        chain: arbitrumSepolia,
        transport: http(config.rpcUrl),
      }) as unknown as PublicClient);
    this.logger = getLogger().child({ poller: 'permission-installed' });
    this.confirmations = BigInt(Math.max(0, config.confirmations ?? 0));
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

  getStatus(): PermissionInstalledIndexerStatus {
    return {
      running: this.running,
      lastProcessedBlock: this.lastProcessedBlock,
    };
  }

  /** Test seam — run a single tick synchronously. */
  async tickOnce(): Promise<void> {
    return this.tick();
  }

  /** Test seam — pin the cursor before a tickOnce. */
  setCursorForTests(block: bigint | null): void {
    this.lastProcessedBlock = block;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const currentBlock = await this.client.getBlockNumber();
      // Reorg buffer: read up to `currentBlock - confirmations` only.
      // Default 0 for hackathon parity with CheckoutSettlementIndexer.
      const safeHead =
        this.confirmations > 0n && currentBlock >= this.confirmations
          ? currentBlock - this.confirmations
          : currentBlock;
      if (this.lastProcessedBlock === null) {
        // First tick on a fresh boot — anchor the cursor at the
        // confirmation-buffered head. Pre-existing PermissionInstalled
        // events that landed before this restart are picked up by the
        // broker-callback path if the broker daemon is still queueing
        // them; otherwise the 60-block watchdog flips stale-pending
        // rows to `'failed'` and the operator re-mints. Re-scanning
        // history would re-process already-handled rows (idempotent
        // via the use-case but wasted RPC bandwidth).
        this.lastProcessedBlock = safeHead;
        return;
      }
      const fromBlock = this.lastProcessedBlock + 1n;
      if (fromBlock > safeHead) return;
      const toBlock =
        safeHead - fromBlock + 1n > MAX_BLOCK_RANGE
          ? fromBlock + MAX_BLOCK_RANGE - 1n
          : safeHead;

      const logs = await this.client.getLogs({
        events: PERMISSION_INSTALLED_EVENT_ABI,
        fromBlock,
        toBlock,
      });

      let retryClampBlock: bigint | null = null;
      for (const lg of logs) {
        const retryNeeded = await this.processLog(lg);
        if (retryNeeded && lg.blockNumber !== null && lg.blockNumber !== undefined) {
          const lb = lg.blockNumber;
          if (retryClampBlock === null || lb < retryClampBlock) {
            retryClampBlock = lb;
          }
        }
      }

      const nextCursor = retryClampBlock !== null ? retryClampBlock - 1n : toBlock;
      if (this.lastProcessedBlock === null || nextCursor > this.lastProcessedBlock) {
        this.lastProcessedBlock = nextCursor;
      }
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'permission-installed indexer tick failed',
      );
      // Cursor not advanced — same window retried next tick.
    } finally {
      this.running = false;
    }
  }

  private async processLog(lg: Log): Promise<boolean> {
    if (!lg.transactionHash || lg.blockNumber === null || lg.blockNumber === undefined) {
      return false;
    }
    let permissionId: Hex;
    try {
      const decoded = decodeEventLog({
        abi: PERMISSION_INSTALLED_EVENT_ABI,
        data: lg.data,
        topics: lg.topics,
      });
      if (decoded.eventName !== 'PermissionInstalled') {
        return false;
      }
      const evArgs = decoded.args as { permission: Hex; nonce: number };
      permissionId = evArgs.permission;
    } catch {
      // Different event with overlapping topic[0] — extremely unlikely
      // for a 4-byte event whose signature is unique, but skip
      // defensively rather than throw.
      return false;
    }

    // Find the matching mirror row. The kernel address (emitter) is
    // `lg.address`. Today the repo lookup is by permissionId alone
    // (see Pg repo JSDoc); we pass the emitter as the disambiguator
    // for future schema growth.
    const session = await this.scopedRepo.findByPermissionIdAndAccountAddress(
      permissionId.toLowerCase() as `0x${string}`,
      lg.address.toLowerCase() as `0x${string}`,
    );
    if (!session) {
      // PermissionInstalled emitted by a kernel we don't track. Common
      // — every dashboard-mediated install fires this event too; our
      // mirror only carries the Scoped-tier rows. Skip silently.
      return false;
    }
    if (session.enableStatus === 'enabled') {
      // Race winner already flipped (broker callback beat us). No-op.
      return false;
    }
    try {
      await this.markEnabled.execute({
        sessionId: session.sessionId,
        txHash: lg.transactionHash.toLowerCase() as `0x${string}`,
        blockNumber: Number(lg.blockNumber),
        logIndex: lg.logIndex ?? 0,
        source: 'chain_indexer',
      });
      this.logger.info(
        {
          sessionId: session.sessionId,
          permissionId: permissionId.toLowerCase(),
          txHash: lg.transactionHash.toLowerCase(),
          blockNumber: lg.blockNumber.toString(),
        },
        'PermissionInstalled → enable_status=enabled (chain indexer)',
      );
      return false;
    } catch (err) {
      if (err instanceof ApplicationHttpError) {
        // 409 (already failed) / 404 (session vanished) are terminal —
        // don't retry. Log + move on. The mirror row is already in a
        // settled state; operator triages the failed case out of band.
        if (err.statusCode === 409 || err.statusCode === 404) {
          this.logger.warn(
            {
              sessionId: session.sessionId,
              statusCode: err.statusCode,
              msg: err.message,
            },
            'PermissionInstalled landed but row in terminal state — skipping',
          );
          return false;
        }
      }
      this.logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          sessionId: session.sessionId,
          permissionId: permissionId.toLowerCase(),
        },
        'PermissionInstalled flip failed — will retry on next tick',
      );
      // Transient — retry next tick. Re-processing is idempotent via
      // `markValidatorEnabled`'s WHERE clause.
      return true;
    }
  }
}
