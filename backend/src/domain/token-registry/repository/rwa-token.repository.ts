import type { RwaToken, TokenStatus } from '../model/rwa-token.js';

export interface IRwaTokenRepository {
  save(token: RwaToken): Promise<void>;
  findById(id: string): Promise<RwaToken | null>;
  findAll(): Promise<RwaToken[]>;
  findByAddress(address: string): Promise<RwaToken | null>;
  findByIssuer(issuerAddress: string): Promise<RwaToken[]>;
  findByStatus(status: TokenStatus): Promise<RwaToken[]>;
  update(token: RwaToken): Promise<void>;
  /**
   * Phase 9.A · Expansion (F1) — point-update of a single column when the
   * on-chain `TokenRegistry.IssuerUpdated` event fires. Lower-cases the
   * lookup at the repo boundary so address-case mismatches between the
   * indexer (event log → `args.token` already checksummed by viem) and
   * the seed-script (`seed-tokens-v35.ts` writes lowercase) don't miss.
   *
   * Must NOT be folded into `save()`'s `onConflictDoUpdate` SET clause —
   * that path is the seed bootstrap. Keeping `issuerAddress` out of the
   * SET clause guarantees a re-seed cannot clobber a rotation the
   * indexer has already applied.
   */
  updateIssuer(tokenAddress: string, newIssuer: string): Promise<void>;

  /**
   * Phase 9.A · Expansion (F1 follow-up) — point-update of `status` when
   * the on-chain `TokenRegistry.PausedUpdated` event fires. Mirrors
   * `updateIssuer` posture: case-insensitive WHERE, idempotent (no-op
   * when the column already matches), updates `pausedAt` to the
   * current timestamp on a paused→active flip back to active is left
   * intentionally NULL (the column means "currently paused since X",
   * not "last paused at Y"). Kept out of `save()`'s SET clause so a
   * re-seed cannot clobber a status flip the indexer has already
   * applied.
   */
  updatePausedStatus(tokenAddress: string, paused: boolean): Promise<void>;
}
