/**
 * Wave 5 Slice 2b (auto-reinvest gate) — the on-chain read port for the
 * reinvest "should I run?" gate.
 *
 * Per the LOCKED decision Q2=(c), the gate is a PURE PUBLIC-DATA read: a
 * user has reinvestable yield iff they hold a FUNDED, unexpired,
 * snapshotted, unclaimed epoch. None of that needs an FHE decrypt — the
 * claimable AMOUNT stays encrypted (amount-blind); only the per-share
 * RATE (`ratePerShare`) is public, and the optional cleartext-bps floor
 * compares against it. This port abstracts the YieldSnapshot reads so the
 * use-case (gate logic) is unit-testable with a stub.
 */

export interface ReinvestTokenTarget {
  /** RWA token address (the buy-leg + audit subject). */
  readonly token: `0x${string}`;
  /** YieldSnapshot proxy address (the claim target). */
  readonly snapshotAddress: `0x${string}`;
}

export interface ClaimableEpoch {
  readonly token: `0x${string}`;
  readonly snapshotAddress: `0x${string}`;
  /** Decimal epoch id (≥ 1; epoch 0 is the no-epoch sentinel). */
  readonly epochId: string;
  /** Public per-share yield rate (scaled by RATE_SCALE = 1e6), decimal string. */
  readonly ratePerShare: string;
}

export interface ReinvestGateReaderInput {
  /** Investor kernel address (the `msg.sender` of the claim). */
  readonly investorAddress: `0x${string}`;
  /** Token+snapshot pairs to scan (deduped by the caller). */
  readonly tokens: readonly ReinvestTokenTarget[];
  readonly nowSec: number;
  /**
   * How many epochs back from `currentEpoch` to scan per token (bounds
   * the RPC fan-out). Defaults to a small window in the reader impl.
   */
  readonly maxEpochLookback?: number;
  /**
   * Optional cleartext floor on the epoch's public `ratePerShare` — an
   * epoch below it is NOT considered reinvestable (the thin cleartext
   * "minYieldBps" analogue). `0n`/undefined → no floor.
   */
  readonly minRatePerShare?: bigint;
}

export interface IReinvestGateReader {
  /**
   * Return every epoch the investor can still claim across `tokens`:
   * `funded && !swept && claimExpiry > now && snapshotted(investor) &&
   * !hasClaimed(investor)`, AND `ratePerShare >= minRatePerShare`. Pure
   * read — never signs or mutates. A per-token RPC failure should be
   * isolated (skip that token) so one bad snapshot doesn't blank the gate.
   */
  findClaimableEpochs(input: ReinvestGateReaderInput): Promise<ClaimableEpoch[]>;
}
