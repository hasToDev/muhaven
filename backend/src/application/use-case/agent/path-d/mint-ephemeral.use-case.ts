import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ApplicationHttpError } from '../../../../core/errors.js';
import { Surface } from '../../../../domain/agent/model/surface.enum.js';
import type { IScopedSessionRepository } from '../../../../domain/agent/repository/scoped-session.repository.js';
import type { IRwaTokenRepository } from '../../../../domain/token-registry/repository/rwa-token.repository.js';
import type { MintEphemeralResponseDto } from '../../../dto/agent/path-d.dto.js';

/**
 * Wave 5 Path D Slice 2a (autonomous claim) — backend mediation for the
 * autonomous-claim "mint an ephemeral EOA" step.
 *
 * `YieldSnapshot.claimYield(epochId, ephemeralEOA)` computes the claimed
 * amount ON-CHAIN (it isn't a client-supplied `InEuint128`), so — UNLIKE
 * the buy/sell path — there is NOTHING to encrypt. The only server-side
 * material the Path-D claim UserOp needs is a throwaway `ephemeralEOA`:
 * the FHE.allow decrypt-grant target for the resulting claimed-amount
 * handle. This use-case is therefore the lighter sibling of
 * `EncryptSharesForPurchaseUseCase` — it shares the revoke kill-switch
 * session gate + token-active check but skips the fhe-worker round-trip.
 *
 * Throwaway semantics match the buy path: the private half is generated,
 * the address derived, the private half dropped. The user's dashboard
 * later re-grants decrypt access to a controllable EOA via
 * `refreshAuditGrant(handle, newEoa)` on the YieldSnapshot (ADR-042
 * mirror) — same cross-session decrypt flow as a post-passkey claim.
 */

export interface MintEphemeralInput {
  /**
   * JWT subject (the kernel-account UUID). Used for the revoke
   * kill-switch gate (`findLatestActive(userId, 'mcp', now)`) — a revoked
   * or expired Scoped session returns null → 403 → the MCP falls back to
   * the Path-C deep-link. Sourced from `authPayload.userId`.
   */
  readonly userId: string;
  /** RWA token whose YieldSnapshot the claim targets. Re-validated against
   *  the catalog so a stale snapshot can't claim against a delisted token. */
  readonly tokenAddress: string;
  /** Injectable clock for the session-active gate. Defaults to `new Date()`. */
  readonly now?: Date;
}

const ADDRESS_HEX = /^0x[0-9a-fA-F]{40}$/;

export class MintEphemeralEoaUseCase {
  constructor(
    private readonly tokenRepo: IRwaTokenRepository,
    private readonly scopedRepo: IScopedSessionRepository,
  ) {}

  async execute(input: MintEphemeralInput): Promise<MintEphemeralResponseDto> {
    if (!ADDRESS_HEX.test(input.tokenAddress)) {
      throw ApplicationHttpError.badRequest(
        'tokenAddress must be a 0x-prefixed 20-byte hex address',
      );
    }

    // REVOKE KILL-SWITCH GATE (mirrors EncryptSharesForPurchaseUseCase).
    // This is the one server-side chokepoint every Path-D claim must hit,
    // so it's the authoritative place to enforce revocation — the broker
    // signs from a local snapshot with no "revoked" concept.
    const nowSec = Math.floor((input.now ?? new Date()).getTime() / 1000);
    const activeSession = await this.scopedRepo.findLatestActive(
      input.userId,
      Surface.MCP,
      nowSec,
    );
    if (!activeSession) {
      throw new ApplicationHttpError(
        403,
        'no active Scoped session for this user — it was revoked or has expired; ' +
          're-mint a Scoped session on the dashboard to authorize autonomous claims',
      );
    }

    // Token catalog check — reject delisted / unknown tokens early.
    const token = await this.tokenRepo.findByAddress(input.tokenAddress);
    if (!token) {
      throw new ApplicationHttpError(404, `token ${input.tokenAddress} not in catalog`);
    }
    if (token.status !== 'active') {
      throw new ApplicationHttpError(
        409,
        `token ${input.tokenAddress} is not active (status=${token.status})`,
      );
    }

    // Mint throwaway ephemeral EOA. The address is the ACL grant target
    // on-chain; the private half is dropped immediately.
    const privateKey = generatePrivateKey();
    const ephemeralEOA = privateKeyToAccount(privateKey).address as `0x${string}`;

    return { ephemeralEOA };
  }
}
