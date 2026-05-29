import {
  createPublicClient,
  http,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import type { Logger } from 'pino';
import { getLogger } from '../../core/logger.js';
import type {
  ClaimableEpoch,
  IReinvestGateReader,
  ReinvestGateReaderInput,
  ReinvestTokenTarget,
} from '../../application/use-case/agent/reinvest/reinvest-gate.port.js';

/**
 * Wave 5 Slice 2b — on-chain implementation of the reinvest gate reader.
 *
 * Pure public reads against each token's YieldSnapshot proxy — NO decrypt,
 * NO signing. An epoch is reinvestable for the investor iff:
 *   funded && !isSwept && claimExpiry > now && snapshotted(investor) &&
 *   !hasClaimed(investor)  [AND ratePerShare >= minRatePerShare].
 *
 * Snapshotted-ness is proxied by `getSnapshotBalance(epochId, investor)
 * != bytes32(0)` — a non-snapshotted investor maps to the zero handle.
 * Per-token failures are isolated (logged + skipped) so one bad snapshot
 * proxy never blanks the whole gate.
 */
const SNAPSHOT_ABI = parseAbi([
  'function currentEpoch(address token) view returns (uint256)',
  'function getEpoch(uint256 epochId) view returns ((address token, uint256 snapshotStartTs, uint256 snapshotEndTs, bool finalized, bool funded, bytes32 encTotalYield, bytes32 encTotalSupply, bytes32 encRatio, uint256 claimExpiry, uint256 holderCount, uint128 ratePerShare))',
  'function hasClaimed(uint256 epochId, address investor) view returns (bool)',
  'function getSnapshotBalance(uint256 epochId, address investor) view returns (bytes32)',
  'function isSwept(uint256 epochId) view returns (bool)',
]);

const ZERO_HANDLE = '0x0000000000000000000000000000000000000000000000000000000000000000';
const DEFAULT_LOOKBACK = 12;
const MAX_LOOKBACK = 64;

export interface ReinvestGateReaderConfig {
  readonly rpcUrl: string;
}

export class OnChainReinvestGateReader implements IReinvestGateReader {
  private readonly publicClient: PublicClient;
  private readonly logger: Logger;

  constructor(config: ReinvestGateReaderConfig) {
    this.publicClient = createPublicClient({
      chain: arbitrumSepolia,
      transport: http(config.rpcUrl),
    });
    this.logger = getLogger('OnChainReinvestGateReader');
  }

  async findClaimableEpochs(input: ReinvestGateReaderInput): Promise<ClaimableEpoch[]> {
    const lookback = Math.min(
      Math.max(input.maxEpochLookback ?? DEFAULT_LOOKBACK, 1),
      MAX_LOOKBACK,
    );
    const minRate = input.minRatePerShare ?? 0n;
    const out: ClaimableEpoch[] = [];

    for (const target of input.tokens) {
      try {
        const found = await this.scanToken(target, input, lookback, minRate);
        out.push(...found);
      } catch (err) {
        // Isolate — one bad snapshot proxy must not blank the gate.
        this.logger.warn(
          { token: target.token, snapshot: target.snapshotAddress, err: errMsg(err) },
          'reinvest gate: skipping token after read failure',
        );
      }
    }
    return out;
  }

  private async scanToken(
    target: ReinvestTokenTarget,
    input: ReinvestGateReaderInput,
    lookback: number,
    minRate: bigint,
  ): Promise<ClaimableEpoch[]> {
    const snapshot = target.snapshotAddress as Address;
    const investor = input.investorAddress as Address;
    const current = (await this.publicClient.readContract({
      address: snapshot,
      abi: SNAPSHOT_ABI,
      functionName: 'currentEpoch',
      args: [target.token as Address],
    })) as bigint;
    if (current <= 0n) return [];

    const lowest = current - BigInt(lookback) + 1n;
    const start = lowest > 1n ? lowest : 1n;
    const found: ClaimableEpoch[] = [];
    for (let epochId = current; epochId >= start; epochId -= 1n) {
      const epoch = (await this.publicClient.readContract({
        address: snapshot,
        abi: SNAPSHOT_ABI,
        functionName: 'getEpoch',
        args: [epochId],
      })) as {
        token: Address;
        finalized: boolean;
        funded: boolean;
        claimExpiry: bigint;
        ratePerShare: bigint;
      };
      // Shared snapshot may serve another token — only count this one's.
      if (epoch.token.toLowerCase() !== target.token.toLowerCase()) continue;
      if (!epoch.funded) continue;
      if (epoch.claimExpiry <= BigInt(input.nowSec)) continue;
      if (minRate > 0n && epoch.ratePerShare < minRate) continue;

      const swept = (await this.publicClient.readContract({
        address: snapshot,
        abi: SNAPSHOT_ABI,
        functionName: 'isSwept',
        args: [epochId],
      })) as boolean;
      if (swept) continue;

      const balHandle = (await this.publicClient.readContract({
        address: snapshot,
        abi: SNAPSHOT_ABI,
        functionName: 'getSnapshotBalance',
        args: [epochId, investor],
      })) as `0x${string}`;
      // Non-snapshotted investor → zero handle → not reinvestable.
      if (balHandle.toLowerCase() === ZERO_HANDLE) continue;

      const claimed = (await this.publicClient.readContract({
        address: snapshot,
        abi: SNAPSHOT_ABI,
        functionName: 'hasClaimed',
        args: [epochId, investor],
      })) as boolean;
      if (claimed) continue;

      found.push({
        token: target.token,
        snapshotAddress: target.snapshotAddress,
        epochId: epochId.toString(),
        ratePerShare: epoch.ratePerShare.toString(),
      });
    }
    return found;
  }
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
