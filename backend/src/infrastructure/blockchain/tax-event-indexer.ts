/**
 * TaxEventIndexer — Wave 3.5 plaintext-marker indexer (ADR-020).
 *
 * Polls Subscription / RedemptionQueue / YieldSnapshot events on a fixed
 * cadence and inserts plaintext markers into `tax_events`. Encrypted
 * amounts are NEVER stored — investors reconstruct amounts client-side
 * from their decrypted handle + the recorded NAV-at-time.
 *
 * Mapping (event → tax_event_type):
 *   MuHavenSubscription.Purchased    → Acquisition
 *   MuHavenSubscription.Redeemed     → Disposition (instant; metadata.kind='instant')
 *                                      or Disposition + metadata.escalated=true
 *                                      when the redeem cap-overflowed and was
 *                                      auto-escalated to the queue
 *   RedemptionQueue.QueueClaimed     → Disposition (queued; metadata.kind='queued')
 *   YieldSnapshot.YieldClaimed       → IncomeAccrual
 *
 * The indexer follows the same `MAX_BLOCK_RANGE` chunking + cursor pinning
 * idioms as `event-poller.ts` so partial failures retry cleanly without
 * losing events. NAV-at-time is fetched via one `oracle.getNAV(token)` per
 * unique token-per-tick (cached in-memory across the same tick) — that's a
 * "best effort" snapshot, not a per-block historical lookup. ADR-020 says
 * the field is for UX sorting; investors compute final amounts client-side.
 */
import {
  createPublicClient,
  http,
  type PublicClient,
  type Address,
  type Log,
} from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import {
  subscriptionTaxAbi,
  redemptionQueueTaxAbi,
  yieldSnapshotTaxAbi,
  redemptionQueueTokenViewAbi,
  oracleNavViewAbi,
} from './tax-event-abis.js';
import { TaxEvent, type TaxEventType } from '../../domain/tax-event/model/tax-event.js';
import type { ITaxEventRepository } from '../../domain/tax-event/repository/tax-event.repository.js';
import { getLogger } from '../../core/logger.js';
import type { Logger } from 'pino';

const MAX_BLOCK_RANGE = 2000n;

export interface TaxEventIndexerConfig {
  rpcUrl: string;
  subscriptionAddress?: Address;
  redemptionQueueAddresses: Address[];
  yieldSnapshotAddresses: Address[];
  oracleAddress?: Address;
  intervalMs: number;
}

export class TaxEventIndexer {
  private readonly client: PublicClient;
  private readonly subscriptionAddress?: Address;
  private readonly redemptionQueueAddresses: Address[];
  private readonly yieldSnapshotAddresses: Address[];
  private readonly oracleAddress?: Address;
  private readonly logger: Logger;
  private lastProcessedBlock: bigint | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly repo: ITaxEventRepository,
    config: TaxEventIndexerConfig,
    client?: PublicClient,
  ) {
    this.client =
      client ??
      createPublicClient({
        chain: arbitrumSepolia,
        transport: http(config.rpcUrl),
      });
    this.subscriptionAddress = config.subscriptionAddress;
    this.redemptionQueueAddresses = config.redemptionQueueAddresses;
    this.yieldSnapshotAddresses = config.yieldSnapshotAddresses;
    this.oracleAddress = config.oracleAddress;
    this.logger = getLogger('TaxEventIndexer');
  }

  start(intervalMs: number): void {
    if (this.intervalHandle) {
      this.logger.warn('Indexer already running');
      return;
    }
    this.logger.info(
      {
        subscription: this.subscriptionAddress ?? null,
        queues: this.redemptionQueueAddresses.length,
        snapshots: this.yieldSnapshotAddresses.length,
        oracle: this.oracleAddress ?? null,
        intervalMs,
      },
      'Starting TaxEventIndexer',
    );
    void this.tick();
    this.intervalHandle = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      this.logger.info('TaxEventIndexer stopped');
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
      if (this.lastProcessedBlock === null) {
        this.lastProcessedBlock = currentBlock;
        this.logger.info(`Initialised cursor at block ${currentBlock}`);
        return;
      }
      if (currentBlock <= this.lastProcessedBlock) return;

      const fromBlock = this.lastProcessedBlock + 1n;
      const events = await this.collectEvents(fromBlock, currentBlock);
      if (events.length > 0) {
        const written = await this.repo.saveMany(events);
        this.logger.info(
          `Indexed ${written} new tax events (${events.length} fetched, blocks ${fromBlock}–${currentBlock})`,
        );
      }
      this.lastProcessedBlock = currentBlock;
    } catch (err) {
      this.logger.error({ err }, 'TaxEventIndexer tick failed — cursor not advanced');
    } finally {
      this.running = false;
    }
  }

  private async collectEvents(fromBlock: bigint, toBlock: bigint): Promise<TaxEvent[]> {
    const all: TaxEvent[] = [];
    for (let start = fromBlock; start <= toBlock; start += MAX_BLOCK_RANGE) {
      const end = start + MAX_BLOCK_RANGE - 1n > toBlock ? toBlock : start + MAX_BLOCK_RANGE - 1n;
      const chunk = await this.fetchChunk(start, end);
      all.push(...chunk);
    }
    return all;
  }

  private async fetchChunk(fromBlock: bigint, toBlock: bigint): Promise<TaxEvent[]> {
    const tasks: Promise<Log[]>[] = [];

    if (this.subscriptionAddress) {
      tasks.push(
        this.client.getLogs({
          address: this.subscriptionAddress,
          events: subscriptionTaxAbi,
          fromBlock,
          toBlock,
        }) as Promise<Log[]>,
      );
    } else {
      tasks.push(Promise.resolve([] as Log[]));
    }

    if (this.redemptionQueueAddresses.length > 0) {
      tasks.push(
        this.client.getLogs({
          address: this.redemptionQueueAddresses,
          events: redemptionQueueTaxAbi,
          fromBlock,
          toBlock,
        }) as Promise<Log[]>,
      );
    } else {
      tasks.push(Promise.resolve([] as Log[]));
    }

    if (this.yieldSnapshotAddresses.length > 0) {
      tasks.push(
        this.client.getLogs({
          address: this.yieldSnapshotAddresses,
          events: yieldSnapshotTaxAbi,
          fromBlock,
          toBlock,
        }) as Promise<Log[]>,
      );
    } else {
      tasks.push(Promise.resolve([] as Log[]));
    }

    const [subLogs, queueLogs, snapLogs] = await Promise.all(tasks);

    const out: TaxEvent[] = [];
    const blockTimestampCache = new Map<bigint, Date>();
    const navCache = new Map<string, string | null>();
    const queueTokenCache = new Map<string, string | null>();

    const fetchBlockTs = async (blockNumber: bigint): Promise<Date> => {
      const cached = blockTimestampCache.get(blockNumber);
      if (cached) return cached;
      const block = await this.client.getBlock({ blockNumber });
      const ts = new Date(Number(block.timestamp) * 1000);
      blockTimestampCache.set(blockNumber, ts);
      return ts;
    };

    const fetchNav = async (token: Address): Promise<string | null> => {
      if (!this.oracleAddress) return null;
      const key = token.toLowerCase();
      if (navCache.has(key)) return navCache.get(key) ?? null;
      try {
        const raw = (await this.client.readContract({
          address: this.oracleAddress,
          abi: oracleNavViewAbi,
          functionName: 'getNAV',
          args: [token],
        })) as readonly [bigint, bigint];
        const nav = raw[0] === 0n ? null : raw[0].toString();
        navCache.set(key, nav);
        return nav;
      } catch {
        navCache.set(key, null);
        return null;
      }
    };

    const fetchQueueToken = async (queue: Address): Promise<string | null> => {
      const key = queue.toLowerCase();
      if (queueTokenCache.has(key)) return queueTokenCache.get(key) ?? null;
      try {
        const tokenAddr = (await this.client.readContract({
          address: queue,
          abi: redemptionQueueTokenViewAbi,
          functionName: 'token',
        })) as Address;
        queueTokenCache.set(key, tokenAddr);
        return tokenAddr;
      } catch (err) {
        this.logger.warn({ err, queue }, 'queue.token() read failed');
        queueTokenCache.set(key, null);
        return null;
      }
    };

    for (const log of subLogs) {
      const built = await this.fromSubscriptionLog(log, fetchBlockTs, fetchNav);
      if (built) out.push(built);
    }
    for (const log of queueLogs) {
      const built = await this.fromQueueLog(log, fetchBlockTs, fetchNav, fetchQueueToken);
      if (built) out.push(built);
    }
    for (const log of snapLogs) {
      const built = await this.fromSnapshotLog(log, fetchBlockTs, fetchNav);
      if (built) out.push(built);
    }

    return out;
  }

  private async fromSubscriptionLog(
    log: Log,
    fetchBlockTs: (b: bigint) => Promise<Date>,
    fetchNav: (token: Address) => Promise<string | null>,
  ): Promise<TaxEvent | null> {
    if (!log.transactionHash || log.blockNumber === null || log.logIndex === null) return null;
    const eventName = (log as Log & { eventName?: string }).eventName;
    const args = (log as Log & { args?: Record<string, unknown> }).args;
    if (!eventName || !args) return null;

    const ts = await fetchBlockTs(log.blockNumber);

    if (eventName === 'Purchased') {
      const token = args.token as Address;
      const investor = args.investor as Address;
      const nav = await fetchNav(token);
      return new TaxEvent({
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        eventType: 'Acquisition' as TaxEventType,
        holderAddress: investor,
        tokenAddress: token,
        blockNumber: log.blockNumber.toString(),
        blockTimestamp: ts,
        navAtTime: nav,
        referenceId: null,
        metadata: null,
      });
    }

    if (eventName === 'Redeemed') {
      const token = args.token as Address;
      const investor = args.investor as Address;
      const escalated = (args.escalated as boolean) ?? false;
      const nav = await fetchNav(token);
      return new TaxEvent({
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        eventType: 'Disposition' as TaxEventType,
        holderAddress: investor,
        tokenAddress: token,
        blockNumber: log.blockNumber.toString(),
        blockTimestamp: ts,
        navAtTime: nav,
        referenceId: null,
        metadata: { kind: escalated ? 'escalated_to_queue' : 'instant' },
      });
    }

    return null;
  }

  private async fromQueueLog(
    log: Log,
    fetchBlockTs: (b: bigint) => Promise<Date>,
    fetchNav: (token: Address) => Promise<string | null>,
    fetchQueueToken: (queue: Address) => Promise<string | null>,
  ): Promise<TaxEvent | null> {
    if (!log.transactionHash || log.blockNumber === null || log.logIndex === null) return null;
    const eventName = (log as Log & { eventName?: string }).eventName;
    const args = (log as Log & { args?: Record<string, unknown> }).args;
    if (eventName !== 'QueueClaimed' || !args) return null;

    const investor = args.investor as Address;
    const requestId = (args.requestId as bigint).toString();
    const tokenAddr = await fetchQueueToken(log.address as Address);
    const nav = tokenAddr ? await fetchNav(tokenAddr as Address) : null;
    const ts = await fetchBlockTs(log.blockNumber);

    return new TaxEvent({
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      eventType: 'Disposition' as TaxEventType,
      holderAddress: investor,
      tokenAddress: tokenAddr,
      blockNumber: log.blockNumber.toString(),
      blockTimestamp: ts,
      navAtTime: nav,
      referenceId: requestId,
      metadata: { kind: 'queued' },
    });
  }

  private async fromSnapshotLog(
    log: Log,
    fetchBlockTs: (b: bigint) => Promise<Date>,
    fetchNav: (token: Address) => Promise<string | null>,
  ): Promise<TaxEvent | null> {
    if (!log.transactionHash || log.blockNumber === null || log.logIndex === null) return null;
    const eventName = (log as Log & { eventName?: string }).eventName;
    const args = (log as Log & { args?: Record<string, unknown> }).args;
    if (eventName !== 'YieldClaimed' || !args) return null;

    const token = args.token as Address;
    const investor = args.investor as Address;
    const epochId = (args.epochId as bigint).toString();
    const ts = await fetchBlockTs(log.blockNumber);
    // IncomeAccrual: NAV is captured for parity with other markers, but the
    // claim itself is denominated in PUSDC, not in shares — UI uses this for
    // sorting only.
    const nav = await fetchNav(token);

    return new TaxEvent({
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      eventType: 'IncomeAccrual' as TaxEventType,
      holderAddress: investor,
      tokenAddress: token,
      blockNumber: log.blockNumber.toString(),
      blockTimestamp: ts,
      navAtTime: nav,
      referenceId: epochId,
      metadata: null,
    });
  }
}
