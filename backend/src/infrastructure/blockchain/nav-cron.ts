/**
 * NavWriterCron — Wave 3.5 Chainlink Functions oracle heartbeat.
 *
 * Loops every `intervalMs` over every active token in `rwaTokens` and calls
 * `oracle.requestNAV(token)` from the configured NAV-writer EOA. The
 * fulfilled NAV lands later via `handleOracleFulfillment` (off-cron).
 *
 * Toggled via env vars `NAV_CRON_ENABLED` + `NAV_CRON_PRIVATE_KEY` +
 * `ORACLE_ADDRESS` per `core/config.ts`. If any are missing the cron is a
 * no-op so dev environments don't burn LINK.
 *
 * The cron does NOT validate that the writer EOA is whitelisted in the
 * oracle's per-token `navRequester` slot — that's a deploy-time
 * configuration. If the call reverts the cron logs and continues; the next
 * tick will retry, so a transient registry mismatch is self-healing.
 */
import { createPublicClient, createWalletClient, http, type Address, type Hash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import type { IRwaTokenRepository } from '../../domain/token-registry/repository/rwa-token.repository.js';
import { getLogger } from '../../core/logger.js';
import type { Logger } from 'pino';

const REQUEST_NAV_ABI = [
  {
    name: 'requestNAV',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: 'requestId', type: 'bytes32' }],
  },
] as const;

export interface NavCronConfig {
  rpcUrl: string;
  oracleAddress: Address;
  navWriterPrivateKey: `0x${string}`;
  intervalMs: number;
}

export interface NavCronTickResult {
  attempted: number;
  succeeded: number;
  failed: number;
  txHashes: Hash[];
}

export class NavWriterCron {
  private readonly oracleAddress: Address;
  private readonly publicClient: ReturnType<typeof createPublicClient>;
  private readonly walletClient: ReturnType<typeof createWalletClient>;
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  private readonly logger: Logger;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastTickAt: Date | null = null;
  private lastResult: NavCronTickResult | null = null;

  constructor(
    private readonly tokenRepo: IRwaTokenRepository,
    config: NavCronConfig,
  ) {
    this.oracleAddress = config.oracleAddress;
    this.account = privateKeyToAccount(config.navWriterPrivateKey);
    this.publicClient = createPublicClient({
      chain: arbitrumSepolia,
      transport: http(config.rpcUrl),
    });
    this.walletClient = createWalletClient({
      account: this.account,
      chain: arbitrumSepolia,
      transport: http(config.rpcUrl),
    });
    this.logger = getLogger('NavWriterCron');
  }

  start(intervalMs: number): void {
    if (this.intervalHandle) {
      this.logger.warn('NavWriterCron already running');
      return;
    }
    this.logger.info(
      { writer: this.account.address, oracle: this.oracleAddress, intervalMs },
      'Starting NAV writer cron',
    );
    void this.safeTick();
    this.intervalHandle = setInterval(() => void this.safeTick(), intervalMs);
  }

  /**
   * Wrap `tick()` so a thrown DB error (e.g. transient Postgres outage)
   * doesn't escape into Node as an unhandled rejection. Per-token RPC
   * failures are already swallowed inside `tick`; this catch is for the
   * "couldn't even read the token list" case.
   */
  private async safeTick(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      this.logger.error({ err }, 'NavWriterCron tick failed (caught at top level)');
    }
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      this.logger.info('NavWriterCron stopped');
    }
  }

  getStatus() {
    return {
      running: this.intervalHandle !== null,
      polling: this.running,
      writer: this.account.address,
      lastTickAt: this.lastTickAt?.toISOString() ?? null,
      lastResult: this.lastResult,
    };
  }

  async tick(): Promise<NavCronTickResult> {
    if (this.running) {
      this.logger.debug('Previous tick still running, skipping');
      return { attempted: 0, succeeded: 0, failed: 0, txHashes: [] };
    }

    this.running = true;
    const result: NavCronTickResult = { attempted: 0, succeeded: 0, failed: 0, txHashes: [] };
    try {
      const tokens = await this.tokenRepo.findByStatus('active');
      if (tokens.length === 0) {
        this.logger.debug('No active tokens registered — NAV cron tick is a no-op');
        return result;
      }

      // Sequential to avoid nonce collisions on a single EOA. Per-tick
      // ordering doesn't matter because each requestNAV is independent.
      for (const token of tokens) {
        result.attempted++;
        try {
          const hash = await this.walletClient.writeContract({
            account: this.account,
            chain: arbitrumSepolia,
            address: this.oracleAddress,
            abi: REQUEST_NAV_ABI,
            functionName: 'requestNAV',
            args: [token.address as `0x${string}`],
          });
          await this.publicClient.waitForTransactionReceipt({ hash });
          result.succeeded++;
          result.txHashes.push(hash);
          this.logger.info({ token: token.address, hash }, 'requestNAV submitted');
        } catch (err) {
          result.failed++;
          this.logger.error({ err, token: token.address }, 'requestNAV failed');
        }
      }
      return result;
    } finally {
      this.running = false;
      this.lastTickAt = new Date();
      this.lastResult = result;
    }
  }
}
