/**
 * Wave 4 P7 — frontend runner ABI map for issuer-side propose tools.
 *
 * Backend mints ActionDescriptors whose `sdkCall.args.txs[]` carries a
 * `(contract, address, fn, args)` tuple per on-chain leg. The runner
 * dispatches each tuple through the ZeroDev kernel sender, but viem
 * needs (a) a function ABI to encode against and (b) positional args
 * (not the object form the backend emits). This file is the
 * (contract, fn) → ABI + positional-args resolver for the three
 * non-FHE P7 tools shipped in Phase 1:
 *
 *   - `unpause_token`  →  TokenRegistry.setPaused(token, paused)
 *   - `kyc_add` (t1)   →  ERC3643KYCAdapter.addToWhitelist(account)
 *   - `kyc_add` (t2)   →  + ERC3643KYCAdapter.addToAccreditedList(account)
 *   - `kyc_remove`     →  ERC3643KYCAdapter.removeFromWhitelist(account)
 *
 * The ABI subset is deliberate — each contract has dozens of fns but
 * the runner only needs to encode these. Keeping the map small means a
 * future P7 tool addition (or governance / Wave 5 surface) lands a
 * single new entry rather than dragging in the full contract ABI.
 *
 * If the descriptor's `(contract, fn)` pair isn't found here, the
 * helper throws `UnknownP7TxError` and the runner returns
 * `{ ok: false, error: ... }` to ConfirmModal — by design, so an
 * unrecognised pair never silently dispatches with the wrong ABI.
 *
 * Wave 4 P7 Phase 2 (`distribute_yield`) does NOT go through this map.
 * That descriptor uses the SDK pipeline (`MuHavenClient.distributeYield`)
 * instead of a raw `txs[]` shape.
 */

import type { Abi } from 'viem'

export class UnknownP7TxError extends Error {
  constructor(contract: string, fn: string) {
    super(`No P7 ABI registered for ${contract}.${fn}`)
    this.name = 'UnknownP7TxError'
  }
}

const TOKEN_REGISTRY_SET_PAUSED: Abi = [
  {
    type: 'function',
    name: 'setPaused',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'paused', type: 'bool' },
    ],
    outputs: [],
  },
]

const KYC_ADD_TO_WHITELIST: Abi = [
  {
    type: 'function',
    name: 'addToWhitelist',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [],
  },
]

const KYC_ADD_TO_ACCREDITED: Abi = [
  {
    type: 'function',
    name: 'addToAccreditedList',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [],
  },
]

const KYC_REMOVE_FROM_WHITELIST: Abi = [
  {
    type: 'function',
    name: 'removeFromWhitelist',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [],
  },
]

interface P7TxBinding {
  abi: Abi
  /**
   * Map the descriptor's unordered `args` object to viem's positional
   * args array. Resolution is by NAMED FIELD, not Object.values order —
   * Object.values order is implementation-defined for non-integer keys
   * in JS, so anchoring on field names is the only safe path.
   */
  orderArgs: (args: Record<string, unknown>) => readonly unknown[]
}

/**
 * (contract, fn) → ABI + positional-args resolver. Resolve via
 * `resolveP7Tx(tx.contract, tx.fn)`; throws `UnknownP7TxError` for
 * unregistered pairs so the runner can surface a clear error to
 * ConfirmModal rather than silently producing a malformed call.
 */
const P7_TX_BINDINGS: Record<string, Record<string, P7TxBinding>> = {
  TokenRegistry: {
    setPaused: {
      abi: TOKEN_REGISTRY_SET_PAUSED,
      orderArgs: (a) => [a.token, a.paused],
    },
  },
  ERC3643KYCAdapter: {
    addToWhitelist: {
      abi: KYC_ADD_TO_WHITELIST,
      orderArgs: (a) => [a.account],
    },
    addToAccreditedList: {
      abi: KYC_ADD_TO_ACCREDITED,
      orderArgs: (a) => [a.account],
    },
    removeFromWhitelist: {
      abi: KYC_REMOVE_FROM_WHITELIST,
      orderArgs: (a) => [a.account],
    },
  },
}

export function resolveP7Tx(contract: string, fn: string): P7TxBinding {
  const binding = P7_TX_BINDINGS[contract]?.[fn]
  if (!binding) throw new UnknownP7TxError(contract, fn)
  return binding
}
