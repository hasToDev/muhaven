/**
 * BlockchainEventPoller — self-hosted alternative to QuickNode webhooks.
 *
 * Polls for escrow and yield distributor events using viem's getLogs,
 * enriches distribution escrows with context, and feeds the same
 * ProcessEscrowEventUseCase pipeline that the webhook endpoint uses.
 *
 * Compatible with future webhook integration — both sources feed the
 * same use case with the same EscrowEventPayload format.
 */
import { createPublicClient, http, type PublicClient } from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import { escrowAbi, yieldDistributorAbi } from './contract-abis.js';
import type { ProcessEscrowEventUseCase, EscrowEventPayload } from '../../application/use-case/webhook/process-escrow-event.use-case.js';
import { getLogger } from '../../core/logger.js';
import type { Logger } from 'pino';

const MAX_BLOCK_RANGE = 2000n;

export interface EventPollerConfig {
  rpcUrl: string;
  escrowAddress: `0x${string}`;
  yieldDistributorAddress: `0x${string}`;
  intervalMs: number;
}

export class BlockchainEventPoller {
  private readonly client: PublicClient;
  private readonly escrowAddress: `0x${string}`;
  private readonly yieldDistributorAddress: `0x${string}`;
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

    // Index BatchProcessed by txHash for same-tx correlation with EscrowCreated
    // Index DistributionStarted by distributionId for token lookup (different tx than BatchProcessed)
    const batchByTx = new Map<string, { distributionId: bigint }>();
    const tokenByDistributionId = new Map<bigint, string>();

    for (const log of distributorLogs) {
      if (log.eventName === 'BatchProcessed' && log.transactionHash) {
        batchByTx.set(log.transactionHash, {
          distributionId: (log as any).args.distributionId,
        });
      }
      if (log.eventName === 'DistributionStarted') {
        const args = (log as any).args;
        tokenByDistributionId.set(args.distributionId, args.token);
      }
    }

    const payloads: EscrowEventPayload[] = [];

    for (const log of escrowLogs) {
      if (!log.transactionHash || log.blockNumber === null) continue;

      const blockNumber = log.blockNumber.toString();
      const txHash = log.transactionHash;

      if (log.eventName === 'EscrowCreated') {
        const args = (log as any).args;
        const escrowId = args.escrowId.toString();
        const beneficiary: string = args.beneficiary;

        const batch = batchByTx.get(txHash);

        const payload: EscrowEventPayload = {
          tx_hash: txHash,
          escrow_id: escrowId,
          event_type: 'EscrowCreated',
          block_number: blockNumber,
          beneficiary,
        };

        // Enrich with distribution context if in same tx as BatchProcessed
        if (batch) {
          payload.distribution_id = Number(batch.distributionId);
          // Look up token address by distributionId (from DistributionStarted in an earlier tx)
          const token = tokenByDistributionId.get(batch.distributionId);
          if (token) {
            payload.token_address = token;
          }
        }

        payloads.push(payload);
      } else if (log.eventName === 'EscrowRedeemed') {
        const args = (log as any).args;
        payloads.push({
          tx_hash: txHash,
          escrow_id: args.escrowId.toString(),
          event_type: 'EscrowRedeemed',
          block_number: blockNumber,
        });
      }
    }

    return payloads;
  }
}
