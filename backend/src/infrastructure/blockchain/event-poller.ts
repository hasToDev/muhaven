/**
 * BlockchainEventPoller — self-hosted alternative to QuickNode webhooks.
 *
 * Polls MuHavenEscrow + YieldDistributor events via viem's getLogs and feeds
 * the same ProcessEscrowEventUseCase pipeline that the webhook endpoint uses.
 *
 * Flow (Phase 19D onwards)
 * ------------------------
 *   MuHavenEscrow events emit only `escrowId` — `beneficiary` is stored as an
 *   encrypted `eaddress` and no longer carried in-event. The poller reconstructs
 *   the escrowId → investor mapping by reading on-chain state after the
 *   `YieldDistributor.EscrowIdsAttached(distributionId, count)` event lands:
 *
 *     1. `yieldDistributor.getEscrowIds(distributionId)` → array of escrowIds
 *     2. `investorRegistry.getInvestorsPaginated(0, count)` → array of addresses
 *     3. Align by index — `escrowIds[i]` is owned by `investors[i]`.
 *     4. Emit one enriched `EscrowCreated` payload per pair (with
 *        distribution_id, beneficiary, token_address).
 *
 *   The raw on-chain `EscrowCreated` logs from `batchCreate` are observed for
 *   telemetry only — they cannot be enriched standalone because the owner is
 *   encrypted.
 *
 *   `EscrowRedeemed` is passed through unchanged.
 */
import { createPublicClient, http, type PublicClient, type Address } from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import {
  escrowAbi,
  yieldDistributorAbi,
  yieldDistributorReadAbi,
  investorRegistryReadAbi,
} from './contract-abis.js';
import type { ProcessEscrowEventUseCase, EscrowEventPayload } from '../../application/use-case/webhook/process-escrow-event.use-case.js';
import { getLogger } from '../../core/logger.js';
import type { Logger } from 'pino';

const MAX_BLOCK_RANGE = 2000n;

export interface EventPollerConfig {
  rpcUrl: string;
  escrowAddress: `0x${string}`;
  yieldDistributorAddress: `0x${string}`;
  investorRegistryAddress: `0x${string}`;
  intervalMs: number;
}

export class BlockchainEventPoller {
  private readonly client: PublicClient;
  private readonly escrowAddress: `0x${string}`;
  private readonly yieldDistributorAddress: `0x${string}`;
  private readonly investorRegistryAddress: `0x${string}`;
  private readonly logger: Logger;
  private lastProcessedBlock: bigint | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly useCase: ProcessEscrowEventUseCase,
    config: EventPollerConfig,
    client?: PublicClient,
  ) {
    this.client = client ?? createPublicClient({
      chain: arbitrumSepolia,
      transport: http(config.rpcUrl),
    });
    this.escrowAddress = config.escrowAddress;
    this.yieldDistributorAddress = config.yieldDistributorAddress;
    this.investorRegistryAddress = config.investorRegistryAddress;
    this.logger = getLogger('BlockchainEventPoller');
  }

  start(intervalMs: number): void {
    if (this.intervalHandle) {
      this.logger.warn('Poller already running');
      return;
    }

    this.logger.info(`Starting poller with interval ${intervalMs}ms`);
    this.tick();
    this.intervalHandle = setInterval(() => this.tick(), intervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      this.logger.info('Poller stopped');
    }
  }

  getStatus() {
    return {
      running: this.intervalHandle !== null,
      polling: this.running,
      lastProcessedBlock: this.lastProcessedBlock?.toString() ?? null,
    };
  }

  async tick(): Promise<void> {
    if (this.running) {
      this.logger.debug('Previous tick still running, skipping');
      return;
    }

    this.running = true;
    try {
      const currentBlock = await this.client.getBlockNumber();

      // First run: set cursor to current block, skip historical logs
      if (this.lastProcessedBlock === null) {
        this.lastProcessedBlock = currentBlock;
        this.logger.info(`Initialized cursor at block ${currentBlock}`);
        return;
      }

      if (currentBlock <= this.lastProcessedBlock) {
        return;
      }

      const fromBlock = this.lastProcessedBlock + 1n;
      const payloads = await this.fetchAndEnrichEvents(fromBlock, currentBlock);

      if (payloads.length > 0) {
        await this.useCase.execute(payloads);
        this.logger.info(`Processed ${payloads.length} events (blocks ${fromBlock}–${currentBlock})`);
      }

      this.lastProcessedBlock = currentBlock;
    } catch (err) {
      this.logger.error({ err }, 'Poller tick failed — cursor not advanced');
    } finally {
      this.running = false;
    }
  }

  private async fetchAndEnrichEvents(fromBlock: bigint, toBlock: bigint): Promise<EscrowEventPayload[]> {
    const allPayloads: EscrowEventPayload[] = [];

    // Chunk into MAX_BLOCK_RANGE segments to respect RPC limits
    for (let start = fromBlock; start <= toBlock; start += MAX_BLOCK_RANGE) {
      const end = start + MAX_BLOCK_RANGE - 1n > toBlock ? toBlock : start + MAX_BLOCK_RANGE - 1n;
      const chunk = await this.fetchChunk(start, end);
      allPayloads.push(...chunk);
    }

    return allPayloads;
  }

  private async fetchChunk(fromBlock: bigint, toBlock: bigint): Promise<EscrowEventPayload[]> {
    // Fetch logs from both contracts in parallel
    const [escrowLogs, distributorLogs] = await Promise.all([
      this.client.getLogs({
        address: this.escrowAddress,
        events: escrowAbi,
        fromBlock,
        toBlock,
      }),
      this.client.getLogs({
        address: this.yieldDistributorAddress,
        events: yieldDistributorAbi,
        fromBlock,
        toBlock,
      }),
    ]);

    // Index DistributionStarted by distributionId for token lookup (usually in
    // the same tx as startDistribution, but may be earlier-block if polling
    // lagged — we also fall back to reading getDistribution on the chain).
    const tokenByDistributionId = new Map<bigint, string>();
    for (const log of distributorLogs) {
      if (log.eventName === 'DistributionStarted') {
        const args = (log as any).args;
        tokenByDistributionId.set(args.distributionId, args.token);
      }
    }

    const payloads: EscrowEventPayload[] = [];

    // ── Enriched EscrowCreated: one per (escrowId, investor) pair per
    //    EscrowIdsAttached event ──────────────────────────────────────────
    for (const log of distributorLogs) {
      if (log.eventName !== 'EscrowIdsAttached') continue;
      if (!log.transactionHash || log.blockNumber === null) continue;

      const args = (log as any).args;
      const distributionId: bigint = args.distributionId;
      const count: bigint = args.count;

      try {
        const [escrowIds, investors, token] = await Promise.all([
          this.client.readContract({
            address: this.yieldDistributorAddress,
            abi: yieldDistributorReadAbi,
            functionName: 'getEscrowIds',
            args: [distributionId],
          }) as Promise<readonly bigint[]>,
          this.client.readContract({
            address: this.investorRegistryAddress,
            abi: investorRegistryReadAbi,
            functionName: 'getInvestorsPaginated',
            args: [0n, count],
          }) as Promise<readonly Address[]>,
          this.resolveToken(tokenByDistributionId, distributionId),
        ]);

        if (escrowIds.length !== investors.length) {
          // Structural impossibility under the contract invariants (registry
          // only appends; setEscrowIds length-matched to investorCount at
          // startDistribution). If it ever fires, either (a) a chain reorg
          // raced the two reads, or (b) an ABI / contract drift. Throw to
          // keep the cursor pinned — next tick retries against a settled
          // state. Silently skipping would lose the distribution's records
          // forever because the event would roll out of the poll window.
          this.logger.error(
            { distributionId: distributionId.toString(), escrowIds: escrowIds.length, investors: investors.length },
            'escrowIds / investors length mismatch — refusing to advance cursor, will retry',
          );
          throw new Error(
            `escrowIds (${escrowIds.length}) / investors (${investors.length}) length mismatch for distribution ${distributionId}`,
          );
        }

        for (let i = 0; i < escrowIds.length; i++) {
          payloads.push({
            tx_hash: log.transactionHash,
            escrow_id: escrowIds[i]!.toString(),
            event_type: 'EscrowCreated',
            block_number: log.blockNumber.toString(),
            distribution_id: Number(distributionId),
            beneficiary: investors[i]!,
            token_address: token,
          });
        }
      } catch (err) {
        this.logger.error(
          { err, distributionId: distributionId.toString() },
          'failed to enrich EscrowIdsAttached — will retry on next poll if the log stays in range',
        );
        // Don't advance the cursor past this chunk so we can retry next tick.
        throw err;
      }
    }

    // ── EscrowRedeemed: straightforward pass-through ──────────────────────
    for (const log of escrowLogs) {
      if (!log.transactionHash || log.blockNumber === null) continue;
      if (log.eventName !== 'EscrowRedeemed') continue;
      const args = (log as any).args;
      payloads.push({
        tx_hash: log.transactionHash,
        escrow_id: args.escrowId.toString(),
        event_type: 'EscrowRedeemed',
        block_number: log.blockNumber.toString(),
      });
    }

    return payloads;
  }

  /**
   * Resolve the token address for a distribution. Prefers the in-window
   * `DistributionStarted` log, falls back to an on-chain read when the
   * distribution was started in a block older than the current poll window
   * (e.g. when setEscrowIds was in a different tx than startDistribution).
   */
  private async resolveToken(
    cache: Map<bigint, string>,
    distributionId: bigint,
  ): Promise<string | undefined> {
    const cached = cache.get(distributionId);
    if (cached) return cached;

    try {
      const dist = await this.client.readContract({
        address: this.yieldDistributorAddress,
        abi: yieldDistributorReadAbi,
        functionName: 'getDistribution',
        args: [distributionId],
      }) as readonly [Address, `0x${string}`, `0x${string}`, bigint, bigint, bigint, number];
      cache.set(distributionId, dist[0]);
      return dist[0];
    } catch (err) {
      this.logger.warn({ err, distributionId: distributionId.toString() }, 'getDistribution read failed');
      return undefined;
    }
  }
}
