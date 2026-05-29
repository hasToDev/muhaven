/**
 * cofhe TaskManager wrapper — minimal frontend surface.
 *
 * The deployed cofhe TaskManager on Arb Sepolia
 * (proxy 0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9 → impl
 *  0x803adbf341545ce1480781007ff018c9faafe1da) handles all the on-chain
 * FHE plumbing — ACL, op-queue, decrypt result store. We only need ONE
 * write entry-point from the frontend: `publishDecryptResult`, used by the
 * Wave 5 W3 Phase 8 claim flow.
 *
 * Background (`development/DEV_WAVE_5/W3_PHASE_8_PLAN.md`): the prod cofhe
 * coprocessor does NOT auto-publish decrypt results in response to
 * on-chain `AllowedForDecryption` events — empirically verified
 * 2026-05-29 (only 1 such event in 5.5h on prod, zero matching publishes).
 * The actual prod flow is client-driven: the user's wallet calls
 * `cofheClient.decryptForTx(handle).withPermit().execute()` to fetch the
 * decrypted value + a Threshold Network signature from `POST /decrypt`,
 * then submits that signed result on-chain via this service. Anyone with
 * a valid signature can publish — TM verifies the signature internally.
 *
 * After the publish lands, `TaskManager._decryptResult[ctHash]` is set
 * and `MuHavenStable.claimUsdc(claimId)` (or any other reader's
 * `FHE.getDecryptResultSafe(handle)`) returns `ready=true`.
 */

import { contractWrite } from './provider'
import type { TxHash } from './types'

// Hard-coded — the cofhe TaskManager is a singleton on the chain, not a
// per-build variable. Matches `TASK_MANAGER_ADDRESS` in the npm package
// `@fhenixprotocol/cofhe-contracts@0.1.3`'s FHE.sol.
export const COFHE_TASK_MANAGER_ADDRESS =
  '0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9' as const

// Minimal ABI — only what we call. Matches `ITaskManager.publishDecryptResult`
// in the npm package's `ICofhe.sol`. Selector `0x18683701`.
const TASK_MANAGER_ABI = [
  {
    type: 'function',
    name: 'publishDecryptResult',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'ctHash', type: 'uint256' },
      { name: 'result', type: 'uint256' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
] as const

const CONTRACT = 'CofheTaskManager'

/**
 * Submit a Threshold Network-decrypted result for `ctHash` on-chain.
 *
 * `value` must match the off-chain decryption of `ctHash`; `signature`
 * is the Threshold Network's ECDSA signature returned by the cofhe SDK's
 * `client.decryptForTx(ctHash).execute()`. The TaskManager verifies the
 * signature against its `decryptResultSigner` and persists the result if
 * valid; otherwise reverts.
 *
 * Idempotence: TM stores results keyed by ctHash. A second publish for
 * an already-recorded handle reverts. The Phase 8 CashPage flow catches
 * this and treats it as success (two-tab race / replay).
 */
export async function publishDecryptResult(
  handleBytes32: `0x${string}`,
  value: bigint,
  signature: `0x${string}`,
): Promise<TxHash> {
  // The npm `ITaskManager.publishDecryptResult` declares the ctHash as
  // uint256 (matching the v0.1.3 schema). Convert the bytes32 handle to
  // its uint256 representation (big-endian, the same value bit-for-bit).
  const ctHash = BigInt(handleBytes32)
  return contractWrite(
    COFHE_TASK_MANAGER_ADDRESS,
    TASK_MANAGER_ABI,
    'publishDecryptResult',
    [ctHash, value, signature],
    CONTRACT,
  )
}
