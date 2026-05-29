import { Surface } from '../../../../domain/agent/model/surface.enum.js';
import type { IScopedSessionRepository } from '../../../../domain/agent/repository/scoped-session.repository.js';
import type { IRwaTokenRepository } from '../../../../domain/token-registry/repository/rwa-token.repository.js';
import type {
  ClaimableEpoch,
  IReinvestGateReader,
  ReinvestTokenTarget,
} from './reinvest-gate.port.js';

/**
 * Wave 5 Slice 2b — the headless reinvest "should I run?" gate.
 *
 * Driver model = Option A (broker-polled): the broker daemon hits
 * `GET /agent/reinvest/should-run` on an interval; when this returns
 * `shouldRun:true` it signs the atomic claim+buy (2c). The backend cannot
 * sign — it only answers the gate.
 *
 * The gate is PUBLIC-DATA only (Q2=(c)): refuse unless the user has an
 * ACTIVE Scoped session (revoke kill-switch) that has OPTED IN
 * (`reinvest_enabled`), then enumerate claimable epochs via public
 * on-chain reads (funded + unexpired + snapshotted + unclaimed). No FHE
 * decrypt; the claimable amount stays encrypted (amount-blind).
 */

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export type ReinvestNotRunReason =
  | 'no_active_session'
  | 'reinvest_disabled'
  | 'no_snapshot_tokens'
  | 'no_claimable_epochs';

export interface GetReinvestShouldRunInput {
  /** JWT subject (kernel-account UUID) — keys the active-session lookup. */
  readonly userId: string;
  /** Investor kernel address (the claim's msg.sender). */
  readonly investorAddress: string;
  /** Injectable clock. Defaults to `new Date()`. */
  readonly now?: Date;
}

export interface GetReinvestShouldRunResult {
  readonly shouldRun: boolean;
  readonly epochs: ClaimableEpoch[];
  /** Why `shouldRun` is false (omitted when true). For operator/LLM clarity. */
  readonly reason?: ReinvestNotRunReason;
}

export interface ReinvestGateOptions {
  /** Per-token epoch lookback window (bounds RPC fan-out). */
  readonly maxEpochLookback?: number;
  /** Optional cleartext floor on the public `ratePerShare`. */
  readonly minRatePerShare?: bigint;
  /**
   * Fallback YieldSnapshot proxy for legacy tokens whose DB
   * `yieldSnapshotAddress` is null (the env singleton). Optional.
   */
  readonly defaultSnapshotAddress?: string;
}

export class GetReinvestShouldRunUseCase {
  constructor(
    private readonly scopedRepo: IScopedSessionRepository,
    private readonly tokenRepo: IRwaTokenRepository,
    private readonly reader: IReinvestGateReader,
    private readonly options: ReinvestGateOptions = {},
  ) {}

  async execute(input: GetReinvestShouldRunInput): Promise<GetReinvestShouldRunResult> {
    const now = input.now ?? new Date();
    const nowSec = Math.floor(now.getTime() / 1000);

    // 1. Revoke kill-switch — no active Scoped session ⇒ never run.
    const session = await this.scopedRepo.findLatestActive(input.userId, Surface.MCP, nowSec);
    if (!session) {
      return { shouldRun: false, epochs: [], reason: 'no_active_session' };
    }
    // 2. Opt-in — the user must have toggled auto-reinvest ON.
    if (!session.reinvestEnabled) {
      return { shouldRun: false, epochs: [], reason: 'reinvest_disabled' };
    }
    if (!ADDR_RE.test(input.investorAddress)) {
      // Defensive — the route sources this from the verified walletAddress
      // claim; a malformed value can't enumerate epochs.
      return { shouldRun: false, epochs: [], reason: 'no_snapshot_tokens' };
    }

    // 3. Resolve the (token, snapshot) pairs to scan: every ACTIVE RWA
    //    token's YieldSnapshot proxy (DB column, or the env singleton
    //    fallback for legacy tokens). Dedup by `(token, snapshot)`.
    const tokens = await this.tokenRepo.findByStatus('active');
    const fallback = this.options.defaultSnapshotAddress;
    const targets: ReinvestTokenTarget[] = [];
    const seen = new Set<string>();
    for (const t of tokens) {
      if (!ADDR_RE.test(t.address)) continue;
      const snap = t.yieldSnapshotAddress ?? fallback;
      if (!snap || !ADDR_RE.test(snap)) continue;
      const key = `${t.address.toLowerCase()}:${snap.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({
        token: t.address.toLowerCase() as `0x${string}`,
        snapshotAddress: snap.toLowerCase() as `0x${string}`,
      });
    }
    if (targets.length === 0) {
      return { shouldRun: false, epochs: [], reason: 'no_snapshot_tokens' };
    }

    // 4. Public on-chain enumeration (no decrypt).
    const epochs = await this.reader.findClaimableEpochs({
      investorAddress: input.investorAddress.toLowerCase() as `0x${string}`,
      tokens: targets,
      nowSec,
      maxEpochLookback: this.options.maxEpochLookback,
      minRatePerShare: this.options.minRatePerShare,
    });

    if (epochs.length === 0) {
      return { shouldRun: false, epochs: [], reason: 'no_claimable_epochs' };
    }
    return { shouldRun: true, epochs };
  }
}
