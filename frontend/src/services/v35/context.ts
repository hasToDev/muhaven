/**
 * Build a Wave 3.5 `MuHavenClientContext` anchored to the current browser
 * session. The context plugs the kernel-backed sender (ZeroDev), the shared
 * public client, and the cofhe client (ephemeral-EOA-signed per ADR-021)
 * into every Wave 3.5 SDK client.
 *
 * Consumers import whichever client they need and instantiate with
 * `new SubscriptionClient(ctx, address)` — the ctx is the same across all
 * clients for a given page/session.
 */

import { createPublicClient, http, type Address, type PublicClient } from 'viem'
import { arbitrumSepolia } from 'viem/chains'
import type { MuHavenClientContext } from '@muhaven/sdk'
import type { CofheLikeClient } from '@muhaven/sdk'
import { createZeroDevSender } from '@/services/contracts/zeroDevSender'
import { useFhe } from '@/composables/useFhe'

const RPC_URL = import.meta.env.VITE_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc'

// Shared public client — thin over the same RPC the legacy provider uses.
// Kept standalone so read-only paths (e.g. Oracle.isFresh) never touch the
// wallet provider and never trigger a passkey prompt.
let _publicClient: PublicClient | null = null
export function getPublicClient(): PublicClient {
  if (!_publicClient) {
    _publicClient = createPublicClient({
      chain: arbitrumSepolia,
      transport: http(RPC_URL),
    })
  }
  return _publicClient
}

/**
 * Read-only context: no sender plumbing, no ephemeral-EOA signing. For
 * `OracleClient.isFresh`, `IdentityRegistryClient.devMode`, etc. that never
 * need to sign anything. Writers must use `buildWriteContext` instead.
 */
export function buildReadContext(): MuHavenClientContext {
  return {
    // `as any` on publicClient matches DistributePage's workaround for the
    // viem dual-install type mismatch between the SDK (node_modules root) and
    // the frontend (node_modules/frontend). Runtime shape is identical.
    publicClient: getPublicClient() as any,
    // Writes will never be called in this path; keep a non-null stub so the
    // context shape still satisfies the SDK type. If a consumer accidentally
    // routes a write through here it fails loudly.
    sender: {
      address: '0x0000000000000000000000000000000000000000',
      getChainId: async () => arbitrumSepolia.id,
      write: async () => {
        throw new Error(
          'v35 read-only context cannot send transactions — use buildWriteContext()',
        )
      },
    },
    cofheClient: {
      encryptInputs: () => {
        throw new Error(
          'v35 read-only context cannot encrypt — use buildWriteContext()',
        )
      },
    } as any,
  }
}

/**
 * Wrap a cofhe client so every `encryptInputs(...)` call is bound to a
 * specific encryption account via `setAccount(senderAddress)`.
 *
 * Why: per Fhenix's ZK-Verifier docs (`encrypting-inputs.mdx#setAccount`),
 * an encrypted input is "owned by" a specific account, and only that
 * account can use it on-chain. The TaskManager's `extractSigner` recovers
 * the verifier signature against `(ctHash, utype, securityZone, msg.sender,
 * chainId)` — so the encryption-time account MUST equal the on-chain
 * `msg.sender` of the contract that calls `FHE.asEuint*(input)`. Otherwise
 * the recovered signer doesn't match `verifierSigner` and the call
 * reverts with `InvalidSigner` (selector `0x7ba5ffb5`).
 *
 * Without this wrapper, the cofhe SDK defaults to the connected wallet
 * client's account — which in our setup is the per-session ephemeral EOA
 * (ADR-021), NOT the kernel that actually originates the on-chain call.
 * See `development/DEV_WAVE_3_5/PHASE8_BLOCKER_COFHE_VERIFIER.md` for the
 * full Phase 8 walk-through (the actual root cause was an unrelated SDK
 * version mismatch, but binding the account is still required correctness
 * for kernel-originated writes).
 *
 * Constraint: this assumes the kernel calls the encrypted-input contract
 * directly. If a future flow inserts an intermediate contract between the
 * kernel and the consumer of `FHE.asEuint*`, that intermediate's address is
 * what `msg.sender` will be — pass that instead. Today every Wave 3.5
 * write goes kernel → contract directly, so `senderAddress = kernel`.
 */
function withSenderAccount(
  cofheClient: CofheLikeClient,
  senderAddress: Address,
): CofheLikeClient {
  return {
    encryptInputs(items: unknown[]) {
      return cofheClient.encryptInputs(items).setAccount(senderAddress)
    },
  }
}

/**
 * Full write context: ZeroDev-backed sender + cofhe client seeded with the
 * ephemeral EOA, then wrapped to bind the encryption account to the kernel.
 * Call from inside a component after the user has signed in. Throws via
 * `createZeroDevSender` / `getRawClient` if not.
 */
export async function buildWriteContext(): Promise<MuHavenClientContext> {
  const { getRawClient } = useFhe()
  const cofheClient = await getRawClient()
  const sender = createZeroDevSender()
  const boundCofhe = withSenderAccount(
    cofheClient as unknown as CofheLikeClient,
    sender.address,
  )
  return {
    publicClient: getPublicClient() as any,
    sender,
    cofheClient: boundCofhe as unknown as MuHavenClientContext['cofheClient'],
  }
}
