import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ApplicationHttpError } from '../../../../core/errors.js';
import { getLogger } from '../../../../core/logger.js';
import type { IRwaTokenRepository } from '../../../../domain/token-registry/repository/rwa-token.repository.js';
import type { FheWorkerClient } from '../../../../infrastructure/fhe/fhe-worker.client.js';
import type { EncryptSharesForPurchaseResponseDto } from '../../../dto/agent/path-d.dto.js';

/**
 * Wave 5 Path D Slice 1 (Commit 3.5) — backend mediation for the
 * autonomous-buy encrypt step.
 *
 * Inputs:
 *   - userId: kernel address (= JWT subject), the on-chain `msg.sender`
 *     of the downstream `subscription.purchase` UserOp. Used as the
 *     `setAccount(...)` binding so the cofhe verifier signs against the
 *     correct sender (otherwise the on-chain TaskManager reverts
 *     `InvalidSigner`).
 *   - tokenAddress: the RWA token the user is buying shares of. We
 *     re-validate against the catalog so a stale snapshot can't request
 *     encryption for a delisted token (the broker's selectorCap targets
 *     subscription.purchase, but a delisted RWA is operator misconfig).
 *   - sharesAmount: cleartext uint128 share count.
 *
 * Outputs the encrypted ciphertext + a fresh-random throwaway EOA for
 * the `subscription.purchase(..., ephemeralEOA)` ACL grant target.
 */

export interface EncryptSharesForPurchaseInput {
  readonly userId: string;
  readonly tokenAddress: string;
  readonly sharesAmount: bigint;
}

/** uint128 max = 2^128 - 1. */
const UINT128_MAX = (1n << 128n) - 1n;
const ADDRESS_HEX = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export class EncryptSharesForPurchaseUseCase {
  constructor(
    private readonly fheWorker: FheWorkerClient,
    private readonly tokenRepo: IRwaTokenRepository,
  ) {}

  async execute(
    input: EncryptSharesForPurchaseInput,
  ): Promise<EncryptSharesForPurchaseResponseDto> {
    // 0. userId MUST be a 0x-prefixed 20-byte hex (the user's kernel
    //    address). The JWT subject is set to this address at login —
    //    a future auth refactor that ever stores something else (UUID,
    //    email) would silently mis-bind the FHE setAccount and revert
    //    on-chain `InvalidSigner`. Reject zero-address as a defensive
    //    invariant — no legitimate kernel deploys to 0x0 (Code Reviewer
    //    L-4, Backend Architect M-1).
    if (!ADDRESS_HEX.test(input.userId)) {
      throw ApplicationHttpError.badRequest(
        'userId must be a 0x-prefixed 20-byte hex address (kernel address)',
      );
    }
    if (input.userId.toLowerCase() === ZERO_ADDRESS) {
      throw ApplicationHttpError.badRequest('userId must not be the zero address');
    }
    // 1. Numeric guardrails. The DTO regex limits the string shape; this
    //    enforces the semantic range — zero/negative reject (silent-
    //    on-chain otherwise), and uint128 max upper bound.
    if (input.sharesAmount <= 0n) {
      throw ApplicationHttpError.badRequest('sharesAmount must be greater than zero');
    }
    if (input.sharesAmount > UINT128_MAX) {
      throw ApplicationHttpError.badRequest('sharesAmount exceeds uint128 max');
    }

    // 2. Token catalog check. Reject delisted / unknown tokens early —
    //    keeps the fhe-worker out of a no-op encrypt for a tx that
    //    would silent-fail on-chain.
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

    // 3. Mint throwaway ephemeral EOA. The address is the ACL grant
    //    target on-chain; the private half is dropped immediately. See
    //    DTO JSDoc for why this is safe — the user can always refresh
    //    the grant from the dashboard via the existing per-token
    //    `refreshDecryptGrant(newEoa)` session-key call.
    const privateKey = generatePrivateKey();
    const ephemeralAccount = privateKeyToAccount(privateKey);
    const ephemeralEOA = ephemeralAccount.address as `0x${string}`;

    // 4. Encrypt via fhe-worker's setAccount-bound endpoint. The 60s
    //    fhe-worker client timeout is preserved; any non-200 from the
    //    worker surfaces as an ApplicationHttpError(500) which the
    //    route maps cleanly.
    const encResult = await this.fheWorker.encryptBatchForAccount(input.userId, [
      { type: 'euint128', value: input.sharesAmount.toString() },
    ]);

    if (encResult.results.length !== 1) {
      getLogger('EncryptSharesForPurchaseUseCase').error(
        { received: encResult.results.length },
        'fhe-worker returned unexpected result count',
      );
      throw ApplicationHttpError.internalError(
        'fhe-worker returned unexpected result count (expected 1)',
      );
    }

    const enc = encResult.results[0]!;
    return {
      encShares: {
        ctHash: enc.data as `0x${string}`,
        securityZone: enc.securityZone,
        utype: enc.utype,
        signature: enc.inputProof as `0x${string}`,
      },
      ephemeralEOA,
    };
  }
}
