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
 *
 * Phase 7.5 note (`MHUSD_WRAPPER_PLAN.md` + ADR-041): the wrapper sits
 * between Subscription/Queue/YieldSnapshot and the legacy PUSDC contract
 * but emits no events of its own that affect tax markers — every taxable
 * transition still surfaces on the upstream Wave 3.5 contracts. This
 * indexer is therefore wrapper-agnostic; pointer rotation in any of the
 * upstream contracts is invisible here.
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
  muHavenStableWrapAbi,
  muHavenTokenTransferAbi,
  tokenRegistryEventsAbi,
  redemptionQueueTokenViewAbi,
  oracleNavViewAbi,
  usdcTransferAbi,
} from './tax-event-abis.js';
import { TaxEvent, type TaxEventType } from '../../domain/tax-event/model/tax-event.js';
import type { ITaxEventRepository } from '../../domain/tax-event/repository/tax-event.repository.js';
import type { TokenRegistryHandler } from './token-registry-handler.js';
import { getLogger } from '../../core/logger.js';
import type { Logger } from 'pino';

const MAX_BLOCK_RANGE = 2000n;

export interface TaxEventIndexerConfig {
  rpcUrl: string;
  subscriptionAddress?: Address;
  redemptionQueueAddresses: Address[];
  yieldSnapshotAddresses: Address[];
  /**
   * Phase 9.A · Option Z — MuHavenStable proxy address. When set, the
   * indexer also subscribes to `Wrap` / `Unwrap` events with their post-
   * upgrade 3-arg signature (the amount handle is stored in metadata).
   * Leave undefined to disable the cash-conversion leg of the feed.
   */
  muHavenStableAddress?: Address;
  /**
   * Phase 9.A · Option Z follow-up — per-RWA MuHavenToken proxy
   * addresses. When non-empty, the indexer subscribes to broadened
   * `Transfer(from, to, amount)` logs from each address, filters out
   * mints / burns / protocol-mediated moves, and inserts two
   * `tax_events` rows per surviving P2P transfer (one keyed by sender,
   * one by recipient). Leave empty to disable the transfer leg of the
   * feed.
   */
  muHavenTokenAddresses?: Address[];
  /**
   * RWA-transfer activity fix (2026-05-31) — DB-backed dynamic resolver for
   * the per-RWA MuHavenToken proxy set. Called once per chunk and MERGED with
   * the static `muHavenTokenAddresses` env list, so a token onboarded AFTER
   * boot is auto-watched on the next poll without a manual
   * `MUHAVEN_TOKEN_ADDRESSES_JSON` rotation + indexer restart. The static env
   * list was hand-maintained (`scripts/onboard-token.sh` only prints a
   * reminder), so any token missing from it had its `Transfer` events silently
   * unwatched → P2P transfers produced ZERO `/activity` rows for sender AND
   * recipient. Mirrors `getKernelAddresses` (the USDC-send leg's dynamic
   * kernel set). Leave undefined to keep the env-only behaviour.
   */
  getMuHavenTokenAddresses?: () => Promise<string[]>;
  /**
   * Phase 9.A · Option Z follow-up — protocol contracts whose Transfer
   * participation should NOT surface as a /activity row. Mint / burn
   * filters (`from == 0` / `to == 0`) catch Subscription's mint+burn
   * legs because those use `address(0)`. The remaining protocol-
   * mediated moves (queue's `pullFromInvestor` / `returnToInvestor`,
   * treasury internal reconciliation, etc.) need explicit
   * sender-or-recipient address filtering. The set typically combines
   * the configured subscription + redemption queue + treasury proxies.
   */
  protocolFilterAddresses?: Address[];
  oracleAddress?: Address;
  /**
   * Wave 5 — the GLOBAL Circle USDC contract address. When set (with a
   * non-empty `getKernelAddresses`), the indexer fetches USDC `Transfer`
   * logs topic-filtered to `from: [kernels]` and inserts a `UsdcSend` row
   * per outbound send to a NON-protocol address (CashPage "Send"). Leave
   * undefined to disable the USDC-send leg.
   */
  usdcAddress?: Address;
  /**
   * Wave 5 — returns the current set of MuHaven kernel (smart-account)
   * addresses. Called once per chunk to build the `from: [kernels]` topic
   * filter for the USDC-send leg, so only our users' sends are fetched from
   * the shared USDC contract (never global volume). NOTE: the topic array
   * grows with the user count — fine at demo/hackathon scale; revisit
   * (windowed enumeration) if the user base nears RPC topic-filter limits.
   */
  getKernelAddresses?: () => Promise<string[]>;
  /**
   * Phase 9.A · Expansion (F1) — `TokenRegistry` proxy address. When set
   * (alongside a non-null `tokenRegistryHandler`), the indexer subscribes
   * to `IssuerUpdated` events so the operator-runbook step
   * `pnpm seed:sync-issuers` is no longer required after a
   * `transfer-issuer.ts` rotation. Leave undefined to disable the
   * registry leg of the feed (e.g. dev environments where TokenRegistry
   * isn't part of the deploy).
   */
  tokenRegistryAddress?: Address;
  intervalMs: number;
}

export class TaxEventIndexer {
  private readonly client: PublicClient;
  private readonly subscriptionAddress?: Address;
  private readonly redemptionQueueAddresses: Address[];
  private readonly yieldSnapshotAddresses: Address[];
  private readonly muHavenStableAddress?: Address;
  private readonly muHavenTokenAddresses: Address[];
  private readonly getMuHavenTokenAddresses?: () => Promise<string[]>;
  /** Lower-cased filter set for fast `has()` lookup during Transfer triage. */
  private readonly protocolFilterAddresses: Set<string>;
  private readonly oracleAddress?: Address;
  private readonly usdcAddress?: Address;
  private readonly getKernelAddresses?: () => Promise<string[]>;
  private readonly tokenRegistryAddress?: Address;
  private readonly tokenRegistryHandler: TokenRegistryHandler | null;
  private readonly logger: Logger;
  private lastProcessedBlock: bigint | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly repo: ITaxEventRepository,
    config: TaxEventIndexerConfig,
    client?: PublicClient,
    tokenRegistryHandler?: TokenRegistryHandler,
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
    this.muHavenStableAddress = config.muHavenStableAddress;
    this.muHavenTokenAddresses = config.muHavenTokenAddresses ?? [];
    this.getMuHavenTokenAddresses = config.getMuHavenTokenAddresses;
    this.protocolFilterAddresses = new Set(
      (config.protocolFilterAddresses ?? []).map((a) => a.toLowerCase()),
    );
    this.oracleAddress = config.oracleAddress;
    this.usdcAddress = config.usdcAddress;
    this.getKernelAddresses = config.getKernelAddresses;
    this.tokenRegistryAddress = config.tokenRegistryAddress;
    // Both the address AND the handler must be present for the registry
    // leg to fire. Pass either alone and the leg stays disabled — the
    // dev-server gate logs the half-configured slot before reaching here.
    this.tokenRegistryHandler =
      this.tokenRegistryAddress && tokenRegistryHandler ? tokenRegistryHandler : null;
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
        muHavenStable: this.muHavenStableAddress ?? null,
        muHavenTokens: this.muHavenTokenAddresses.length,
        protocolFilter: this.protocolFilterAddresses.size,
        oracle: this.oracleAddress ?? null,
        usdc: this.usdcAddress ?? null,
        tokenRegistry: this.tokenRegistryAddress ?? null,
        intervalMs,
      },
      'Starting TaxEventIndexer',
    );
    // Pre-flight contract-existence probe: if any configured subscription
    // address has no code on chain, the indexer is silently inert against
    // it (eth_getLogs returns nothing). The most common cause is a stale
    // .env after a redeploy — symptom is "tx confirmed but row never
    // appears on /activity". Probe runs in the background so it never
    // blocks the first tick; failures are warn-only.
    void this.probeContractExistence();
    void this.tick();
    this.intervalHandle = setInterval(() => void this.tick(), intervalMs);
  }

  /**
   * Phase 9.A · Option Z follow-up · staging-drift defence — `getCode` each
   * configured indexer-subscription address. A `0x` (no-code) result means
   * the env var is stale (typically after a fresh `pnpm run
   * deploy:v2:testnet:stage` + `bash scripts/onboard-token.sh <symbol>
   * stage` round) and the leg silently produces zero logs. Loud-warn so
   * the operator catches this on container boot rather than at user-
   * report time. RPC failures during the probe are tolerated — we'd
   * rather start the indexer and let `tick()` surface chain issues than
   * block boot on a flaky probe.
   */
  private async probeContractExistence(): Promise<void> {
    const targets: Array<{ label: string; address: Address }> = [];
    if (this.subscriptionAddress) {
      targets.push({ label: 'subscription', address: this.subscriptionAddress });
    }
    for (const a of this.redemptionQueueAddresses) {
      targets.push({ label: 'redemptionQueue', address: a });
    }
    for (const a of this.yieldSnapshotAddresses) {
      targets.push({ label: 'yieldSnapshot', address: a });
    }
    if (this.muHavenStableAddress) {
      targets.push({ label: 'muHavenStable', address: this.muHavenStableAddress });
    }
    for (const a of this.muHavenTokenAddresses) {
      targets.push({ label: 'muHavenToken', address: a });
    }
    if (this.tokenRegistryAddress) {
      targets.push({ label: 'tokenRegistry', address: this.tokenRegistryAddress });
    }
    // Wave 5 — probe the USDC contract too (BE-Arch review LOW). A stale/wrong
    // CIRCLE_USDC_ADDRESS (e.g. mainnet USDC pasted into a testnet env) would
    // silently produce zero send rows; the boot warn catches it.
    if (this.usdcAddress) {
      targets.push({ label: 'circleUsdc', address: this.usdcAddress });
    }
    if (targets.length === 0) return;

    await Promise.all(
      targets.map(async ({ label, address }) => {
        try {
          // `getCode` is the post-2.x viem name; `getBytecode` is the
          // deprecated alias. Use the canonical name so we don't trip a
          // future viem major-version removal.
          const code = await this.client.getCode({ address });
          if (!code || code === '0x') {
            this.logger.warn(
              { label, address },
              'Configured indexer address has NO CODE on chain — env likely stale post-redeploy. Subscription leg will silently produce zero logs. Cross-check `deployments/arb-sepolia-v2*.json` and rotate the env var.',
            );
          }
        } catch (err) {
          this.logger.debug(
            { err, label, address },
            'Contract-existence probe failed (RPC error) — skipping; tick() will retry organically',
          );
        }
      }),
    );
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
        // Init cursor one block BEFORE current head so the next tick
        // covers `currentBlock` inclusively. The previous shape
        // (`lastProcessedBlock = currentBlock`) silently dropped any
        // event in the block of indexer-boot — `fromBlock = cursor + 1`
        // skipped past it — which made restart-during-user-tx a
        // permanent-data-loss footgun. `currentBlock - 1n` is safe at
        // genesis: BigInt allows -1n; the next tick's `fromBlock = 0n`
        // is a valid getLogs range.
        this.lastProcessedBlock = currentBlock - 1n;
        this.logger.info(
          `Initialised cursor at block ${currentBlock - 1n} (next tick starts at ${currentBlock})`,
        );
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

  /**
   * RWA-transfer activity fix (2026-05-31) — merge the static env token list
   * with the DB-backed dynamic resolver into the per-chunk MuHavenToken watch
   * set. Deduped case-insensitively (env addresses are checksummed; DB rows may
   * be checksummed OR lowercase depending on the writer — so the same proxy from
   * both sources must not double-query) and hex-validated (a malformed DB row
   * can't poison the getLogs address filter).
   * Fail-soft: a resolver error falls back to the static env list so we never
   * regress BELOW the prior env-only behaviour (matches the getKernelAddresses
   * degradation contract for the USDC-send leg).
   */
  private async resolveTokenAddresses(): Promise<Address[]> {
    const merged = new Map<string, Address>();
    for (const a of this.muHavenTokenAddresses) merged.set(a.toLowerCase(), a);
    if (this.getMuHavenTokenAddresses) {
      try {
        const dynamic = await this.getMuHavenTokenAddresses();
        for (const a of dynamic) {
          if (!/^0x[0-9a-fA-F]{40}$/.test(a)) continue;
          const key = a.toLowerCase();
          if (!merged.has(key)) merged.set(key, a as Address);
        }
      } catch (err) {
        this.logger.warn(
          { err },
          'getMuHavenTokenAddresses failed — using the static env token list this chunk',
        );
      }
    }
    return [...merged.values()];
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

    if (this.muHavenStableAddress) {
      tasks.push(
        this.client.getLogs({
          address: this.muHavenStableAddress,
          events: muHavenStableWrapAbi,
          fromBlock,
          toBlock,
        }) as Promise<Log[]>,
      );
    } else {
      tasks.push(Promise.resolve([] as Log[]));
    }

    // RWA-transfer activity fix (2026-05-31) — resolve the watch-set as
    // (static env list) ∪ (DB token registry) so onboarded tokens are
    // auto-watched without an env rotation. Resolved per chunk to mirror the
    // USDC-send leg's `getKernelAddresses`; fail-soft to the env list.
    const tokenAddrsForChunk = await this.resolveTokenAddresses();
    if (tokenAddrsForChunk.length > 0) {
      tasks.push(
        // Isolate THIS leg's failure with `.catch(() => [])`, mirroring the
        // USDC-send leg below. The `address` array is now DB-driven (grows as
        // issuers onboard tokens), so an address-list-too-large rejection or a
        // transient RPC error on this leg must NOT propagate into the bare
        // `Promise.all(tasks)` → `tick()` catch → cursor NOT advanced → EVERY
        // tick fails → the WHOLE indexer freezes (Acquisition / Disposition /
        // yield / Wrap / USDC included) — the "silent total stall" class this
        // repo has already been bitten by. Degrade to "no transfer rows this
        // chunk": the cursor still advances on the other legs and the next tick
        // retries (same availability tradeoff the USDC leg + getKernelAddresses
        // already accept — a permanent miss of those blocks' transfers is the
        // accepted cost vs. halting all indexing). The pre-fix static leg was
        // bare, but it was bounded by the hand-maintained env list; a DB-driven
        // set needs the guard.
        (
          this.client.getLogs({
            address: tokenAddrsForChunk,
            events: muHavenTokenTransferAbi,
            fromBlock,
            toBlock,
          }) as Promise<Log[]>
        ).catch((err: unknown) => {
          this.logger.warn(
            { err, tokens: tokenAddrsForChunk.length },
            'MuHavenToken Transfer getLogs failed (address-list limit? RPC error?) — skipping transfer leg this chunk',
          );
          return [] as Log[];
        }),
      );
    } else {
      tasks.push(Promise.resolve([] as Log[]));
    }

    // Phase 9.A · Expansion (F1) — registry leg. Logs are dispatched into
    // `TokenRegistryHandler` (NOT folded into `tax_events`) — issuer
    // rotation is a config change, not a holder-keyed taxable marker.
    if (this.tokenRegistryAddress && this.tokenRegistryHandler) {
      tasks.push(
        this.client.getLogs({
          address: this.tokenRegistryAddress,
          events: tokenRegistryEventsAbi,
          fromBlock,
          toBlock,
        }) as Promise<Log[]>,
      );
    } else {
      tasks.push(Promise.resolve([] as Log[]));
    }

    // Wave 5 — USDC-send leg. Topic-filter the GLOBAL USDC contract to our
    // users' OUTBOUND sends (`from: [kernels]`) so we never pull global
    // volume. Fetch the kernel set once per chunk; skip the whole leg if the
    // address or provider is unset, the fetch fails, or the set is empty (a
    // fresh DB with no users).
    let usdcKernels: string[] = [];
    if (this.usdcAddress && this.getKernelAddresses) {
      try {
        usdcKernels = (await this.getKernelAddresses()).filter((a) =>
          /^0x[0-9a-fA-F]{40}$/.test(a),
        );
      } catch (err) {
        // Deliberate: a kernel-set fetch failure skips ONLY the USDC leg this
        // chunk (usdcKernels stays []) — the other legs still run and the
        // cursor advances on chunk success. In practice getKernelAddresses and
        // saveMany hit the SAME Postgres, so a real DB outage throws in
        // saveMany too → whole chunk aborts → cursor holds → both recover on
        // the next tick. The only gap is a kernel-query failure INDEPENDENT of
        // the write path (e.g. a query timeout while writes succeed), which
        // would skip those blocks' USDC sends permanently. Acceptable at demo
        // scale; the alternative (rethrow → stall ALL indexing on a USDC-leg
        // hiccup) is the worse availability tradeoff. (BE-Arch review LOW-1.)
        this.logger.warn(
          { err },
          'getKernelAddresses failed — skipping USDC-send leg this chunk',
        );
      }
    }
    if (this.usdcAddress && usdcKernels.length > 0) {
      tasks.push(
        // `as any` on the params: viem's getLogs doesn't infer the indexed
        // `from` topic filter from a `const` abi event element here (it widens
        // `args` to `undefined`). The call is correct at runtime — `from` is an
        // indexed param of the standard ERC-20 Transfer event, and an address
        // array is viem's OR-filter form.
        // BE-Arch review #2 (load-bearing): isolate THIS leg's failure with a
        // `.catch(() => [])`. The `from: [kernels]` topic array grows unbounded
        // with the user count; once it exceeds the RPC's topic-list limit the
        // getLogs rejects, and inside the bare `Promise.all(tasks)` below that
        // rejection would propagate → `tick()` catch → cursor NOT advanced →
        // EVERY tick fails → the WHOLE indexer freezes (Acquisition / Disposition
        // / yield / Wrap included), the "silent total stall" class this repo has
        // already been bitten by. Degrading to "no USDC rows this chunk" matches
        // the failure semantics already chosen for getKernelAddresses above and
        // keeps the revenue-critical legs alive. The frozen-USDC symptom is
        // self-evident (no new send rows) vs. a total indexing halt.
        this.client
          .getLogs({
            address: this.usdcAddress,
            event: usdcTransferAbi[0],
            args: { from: usdcKernels as `0x${string}`[] },
            fromBlock,
            toBlock,
          } as any)
          .catch((err: unknown) => {
            this.logger.warn(
              { err, kernels: usdcKernels.length },
              'USDC-send getLogs failed (topic-array limit? RPC error?) — skipping leg this chunk',
            );
            return [] as Log[];
          }) as Promise<Log[]>,
      );
    } else {
      tasks.push(Promise.resolve([] as Log[]));
    }

    const [subLogs, queueLogs, snapLogs, stableLogs, transferLogs, registryLogs, usdcLogs] =
      await Promise.all(tasks);

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
    for (const log of stableLogs) {
      const built = await this.fromStableLog(log, fetchBlockTs);
      if (built) out.push(built);
    }
    for (const log of transferLogs) {
      const built = await this.fromTransferLog(log, fetchBlockTs);
      if (built !== null) out.push(...built);
    }

    // Registry logs are side-effecting (mutate `rwa_tokens.issuer_address`
    // for IssuerUpdated, `rwa_tokens.status` for PausedUpdated) rather
    // than producing `tax_events` rows. Dispatch by event name so a
    // single chunk carrying both event types lands both writes; a throw
    // in either aborts the chunk and propagates up to `tick()`'s catch —
    // the cursor MUST NOT advance past a chunk where a registry write
    // failed, otherwise the rotation/status flip is lost forever.
    if (this.tokenRegistryHandler) {
      for (const log of registryLogs) {
        const eventName = (log as Log & { eventName?: string }).eventName;
        if (eventName === 'IssuerUpdated') {
          await this.tokenRegistryHandler.applyIssuerUpdated(log);
        } else if (eventName === 'PausedUpdated') {
          await this.tokenRegistryHandler.applyPausedUpdated(log);
        }
        // Other registry events (MinInvestmentUpdated etc.) have no DB
        // mirror today; ignore — adding the leg is the next iteration.
      }
    }

    for (const log of usdcLogs) {
      const built = await this.fromUsdcSendLog(log, fetchBlockTs);
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
    // Phase 9.A audit-handle follow-up: broadened YieldClaimed event
    // carries an `amount` handle (bytes32). Older events from the
    // pre-upgrade contract have args.amount === undefined — capture
    // when present so /activity can render a Decrypt button on the
    // claim row, fall back gracefully on legacy events.
    const amountHandle = args.amount as `0x${string}` | undefined;
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
      metadata: amountHandle ? { encrypted_amount_handle: amountHandle } : null,
    });
  }

  /**
   * Phase 9.A · Option Z follow-up — `MuHavenToken.Transfer(from, to,
   * amount)` mapper. Returns up to TWO `TaxEvent` rows per qualifying
   * event (one keyed by sender, one by recipient) so each side's
   * /activity feed surfaces the move from their own perspective. The
   * extended `tax_events` PK `(tx_hash, log_index, holder_address)` lets
   * both rows coexist.
   *
   * Filters (returns `null` to skip):
   *   - mints (`from == 0x0`) — already covered by Subscription.Purchased
   *   - burns (`to == 0x0`) — already covered by Subscription.Redeemed +
   *     RedemptionQueue.QueueClaimed
   *   - protocol-mediated moves where `from` or `to` is in
   *     `protocolFilterAddresses` (queue / subscription / treasury / etc.)
   *
   * Whatever survives is a true P2P transfer. Both rows store the amount
   * handle in `metadata.encrypted_amount_handle` so the frontend's
   * decrypt-on-click flow uses the same shape as Wrap/Unwrap.
   */
  private async fromTransferLog(
    log: Log,
    fetchBlockTs: (b: bigint) => Promise<Date>,
  ): Promise<TaxEvent[] | null> {
    if (!log.transactionHash || log.blockNumber === null || log.logIndex === null) return null;
    const eventName = (log as Log & { eventName?: string }).eventName;
    const args = (log as Log & { args?: Record<string, unknown> }).args;
    if (eventName !== 'Transfer' || !args) return null;

    const from = (args.from as Address | undefined) ?? null;
    const to = (args.to as Address | undefined) ?? null;
    const amountHandle = args.amount as `0x${string}` | undefined;
    if (!from || !to) return null;

    // Mint / burn — covered by upstream Subscription / Queue indexers.
    const ZERO = '0x0000000000000000000000000000000000000000';
    if (from.toLowerCase() === ZERO || to.toLowerCase() === ZERO) return null;

    // Protocol-mediated move (queue / subscription / treasury / ...).
    if (
      this.protocolFilterAddresses.has(from.toLowerCase()) ||
      this.protocolFilterAddresses.has(to.toLowerCase())
    ) {
      return null;
    }

    const tokenAddress = log.address as Address;
    const ts = await fetchBlockTs(log.blockNumber);

    // Build two rows — the use-case maps `metadata.direction` to the
    // 'transfer-out' / 'transfer-in' ActivityItemType.
    const baseProps = {
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      eventType: 'Transfer' as TaxEventType,
      tokenAddress,
      blockNumber: log.blockNumber.toString(),
      blockTimestamp: ts,
      // Transfers don't snapshot NAV — the audit handle is the amount in
      // share-units; investor reconstructs USD from current NAV at view
      // time. (Same convention as Wrap/Unwrap which also store no NAV.)
      navAtTime: null,
      referenceId: null,
    };

    const senderRow = new TaxEvent({
      ...baseProps,
      holderAddress: from,
      metadata: {
        kind: 'transfer',
        direction: 'outbound',
        counterparty: to,
        encrypted_amount_handle: amountHandle ?? null,
      },
    });
    const recipientRow = new TaxEvent({
      ...baseProps,
      holderAddress: to,
      metadata: {
        kind: 'transfer',
        direction: 'inbound',
        counterparty: from,
        encrypted_amount_handle: amountHandle ?? null,
      },
    });

    return [senderRow, recipientRow];
  }

  /**
   * Phase 9.A · Option Z — `MuHavenStable.Wrap` / `Unwrap` mapper. Cash
   * conversions emit no NAV (the mhUSDC peg is 1:1 USDC by construction)
   * and no token address (cash isn't an RWA — `tokenAddress=null`). The
   * encrypted amount handle is stored verbatim in
   * `metadata.encrypted_amount_handle` so the frontend can fetch it via
   * the activity API and decrypt via permit.
   */
  private async fromStableLog(
    log: Log,
    fetchBlockTs: (b: bigint) => Promise<Date>,
  ): Promise<TaxEvent | null> {
    if (!log.transactionHash || log.blockNumber === null || log.logIndex === null) return null;
    const eventName = (log as Log & { eventName?: string }).eventName;
    const args = (log as Log & { args?: Record<string, unknown> }).args;
    if (!args || (eventName !== 'Wrap' && eventName !== 'Unwrap' && eventName !== 'WrapUsdc')) {
      return null;
    }
    const ts = await fetchBlockTs(log.blockNumber);

    // Wave 5 W3 Phase 9 — `WrapUsdc` (the single-step direct USDC→mhUSDC
    // deposit) keys its holder on `from` (not `account`) and carries BOTH a
    // CLEARTEXT USDC `amount` and the encrypted mhUSDC `amountHandle`. We index
    // it as a cash-rail `Wrap` row so it (a) shows on /activity like any other
    // deposit and (b) satisfies `hasCashRailActivity` for the agent buy gate.
    if (eventName === 'WrapUsdc') {
      const from = args.from as Address;
      const ephemeralEOA = (args.ephemeralEOA as Address) ?? null;
      const amountHandle = args.amountHandle as `0x${string}` | undefined;
      const cleartextAmount = args.amount as bigint | undefined;
      return new TaxEvent({
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        eventType: 'Wrap',
        holderAddress: from,
        tokenAddress: null,
        blockNumber: log.blockNumber.toString(),
        blockTimestamp: ts,
        navAtTime: null,
        referenceId: null,
        metadata: {
          kind: 'wrap',
          encrypted_amount_handle: amountHandle ?? null,
          // Base-6 USDC, public. Stringified so the JSON metadata never carries
          // a BigInt (matches the UsdcSend leg's cleartext_amount convention).
          cleartext_amount: cleartextAmount != null ? cleartextAmount.toString() : null,
          ephemeral_eoa: ephemeralEOA,
        },
      });
    }

    const account = args.account as Address;
    const ephemeralEOA = (args.ephemeralEOA as Address) ?? null;
    const amountHandle = args.amount as `0x${string}` | undefined;

    return new TaxEvent({
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      eventType: eventName as TaxEventType,
      holderAddress: account,
      tokenAddress: null,
      blockNumber: log.blockNumber.toString(),
      blockTimestamp: ts,
      navAtTime: null,
      referenceId: null,
      metadata: {
        kind: eventName === 'Wrap' ? 'wrap' : 'unwrap',
        encrypted_amount_handle: amountHandle ?? null,
        ephemeral_eoa: ephemeralEOA,
      },
    });
  }

  /**
   * Wave 5 — cleartext USDC `Transfer(from, to, value)` mapper for the
   * CashPage "Send" off-ramp. The `from: [kernels]` topic filter guarantees
   * the sender is one of our kernels, so we key the row by `from` and record
   * the PUBLIC `value` cleartext in `metadata.cleartext_amount` (no encrypted
   * handle, no decrypt CTA on the frontend).
   *
   * Returns `null` to skip:
   *   - burns (`to == 0x0`) — defensive; USDC has no burn-to-zero in normal flow
   *   - sends to a protocol address (`to` in `protocolFilterAddresses`) — the
   *     `wrapUsdc` deposit pulls USDC kernel→wrapper and already surfaces as a
   *     `Wrap` row; re-surfacing it as a send would double-count. (The wrapper
   *     address must be in the filter set — wired in `dev-server.ts`.)
   *
   * `tokenAddress` is null (USDC is a cash rail, not an RWA — same convention
   * as Wrap/Unwrap); `navAtTime` is null (USD-denominated, no NAV semantic).
   */
  private async fromUsdcSendLog(
    log: Log,
    fetchBlockTs: (b: bigint) => Promise<Date>,
  ): Promise<TaxEvent | null> {
    if (!log.transactionHash || log.blockNumber === null || log.logIndex === null) return null;
    const eventName = (log as Log & { eventName?: string }).eventName;
    const args = (log as Log & { args?: Record<string, unknown> }).args;
    if (eventName !== 'Transfer' || !args) return null;

    const from = (args.from as Address | undefined) ?? null;
    const to = (args.to as Address | undefined) ?? null;
    const value = args.value as bigint | undefined;
    if (!from || !to) return null;

    const ZERO = '0x0000000000000000000000000000000000000000';
    if (to.toLowerCase() === ZERO) return null;
    if (this.protocolFilterAddresses.has(to.toLowerCase())) return null;

    const ts = await fetchBlockTs(log.blockNumber);

    return new TaxEvent({
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      eventType: 'UsdcSend' as TaxEventType,
      holderAddress: from,
      tokenAddress: null,
      blockNumber: log.blockNumber.toString(),
      blockTimestamp: ts,
      navAtTime: null,
      referenceId: null,
      metadata: {
        kind: 'usdc-send',
        direction: 'outbound',
        counterparty: to,
        cleartext_amount: value !== undefined ? value.toString() : null,
      },
    });
  }
}
