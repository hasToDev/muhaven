/**
 * Unit tests for `useAgentActionRunner.runAgentAction` — the agent
 * ConfirmModal's dispatch entry point.
 *
 * Scope (Phase 1):
 *   - The three P7 issuer-side runner cases (`unpause_token`, `kyc_add`,
 *     `kyc_remove`) and the shared `dispatchActionTxs` helper.
 *   - The `default` branch (`Unknown action kind`).
 *
 * NOT in scope here (separate tests when those gain test surface):
 *   - `runBuy` — pulls in FHE / cofhe / portfolio store; needs heavier
 *     mocking. Backend p7-issuer-tools.test.ts + walkthrough cover it.
 *   - `set_policy` / `pause` / `create_checkout` — deferred branches +
 *     server-side leg; covered by their dedicated paths.
 *
 * Mocking strategy: stub `@/services/v35/context.buildWriteContext` to
 * return a fake sender with `write: vi.fn()`. The real
 * `@/services/v35/p7-tx-abis.resolveP7Tx` runs pure (no side effects)
 * so we leave it un-mocked — asserting against the real binding catches
 * any drift between the ABI map and what the runner actually dispatches.
 *
 * Store imports inside `invalidateIssuerCachesAfterP7Write` are also
 * stubbed so each test stays free of Pinia bootstrap noise.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ActionDescriptor } from '@/services/api'

// ── Shared stub state for distribute_yield mocks ────────────────────
// vi.mock factories are hoisted to the top of the file — `const`
// declarations below them are NOT visible at factory-evaluation time.
// `vi.hoisted` is the supported escape hatch: the callback is also
// hoisted, so the holder it returns is in scope by the time each
// vi.mock factory runs.
//
// Rewire 2026-05-22: switched from MuHavenClient.distributeYield mocks
// to the YieldSnapshot pipeline (snapshotProxyFor + tokenRegistry
// readContract issuer match + detectInFlight + loadAllHolders +
// YieldSnapshotClient.{openEpoch,snapshotAll,finalizeSnapshot,fundEpoch}
// + refreshSnapshotSupplyGrant + decryptSnapshotSupplyForView +
// getEpochTotalSupplyHandle).
const distributeStubs = vi.hoisted(() => ({
  kernelAddress: '0x1111111111111111111111111111111111111111' as string | null,
  issuerTokens: [{ address: '0xaaaa000000000000000000000000000000000001' }] as Array<{ address: string }>,
  loadFn: vi.fn(),
  resetFn: vi.fn(),
  setOperator: vi.fn(),
  fheInit: vi.fn(),
  // YieldSnapshot pipeline mocks
  snapshotProxyFor: vi.fn(),
  detectInFlight: vi.fn(),
  loadAllHolders: vi.fn(),
  refreshSnapshotSupplyGrant: vi.fn(),
  getEpochTotalSupplyHandle: vi.fn(),
  decryptSnapshotSupplyForView: vi.fn(),
  // YieldSnapshotClient instance methods
  openEpochFn: vi.fn(),
  snapshotAllFn: vi.fn(),
  finalizeSnapshotFn: vi.fn(),
  fundEpochFn: vi.fn(),
  yieldSnapshotClientCtor: vi.fn(),
  // viem readContract mock for the on-chain TokenRegistry.getConfig
  // issuer-match check.
  publicReadContract: vi.fn(),
  // Runner reads getEphemeralEOA() to thread through refreshGrant.
  ephemeralEOA: '0x2222222222222222222222222222222222222222' as `0x${string}`,
}))

// `useAgentActionRunner` lazy-imports `@/stores/issuer-tokens` +
// `@/stores/issuer-investors` inside `invalidateIssuerCachesAfterP7Write`.
// Pre-stub them to no-op stores so the post-dispatch cache reset doesn't
// pull Pinia into the unit-test boot path. The issuer-tokens stub also
// satisfies runDistribute's preview.tokenAddress registration check.
vi.mock('@/stores/issuer-tokens', () => ({
  useIssuerTokensStore: () => ({
    reset: distributeStubs.resetFn,
    get tokens() {
      return distributeStubs.issuerTokens
    },
    load: distributeStubs.loadFn,
  }),
}))
vi.mock('@/stores/issuer-investors', () => ({
  useIssuerInvestorsStore: () => ({ reset: vi.fn() }),
}))

// wallet store — runDistribute reads `wallet.address` to bind against
// preview.issuerAddress. The kernelAddress holder lets each test rewrite
// it without re-mocking the module.
vi.mock('@/stores/wallet', () => ({
  useWalletStore: () => ({
    get address() {
      return distributeStubs.kernelAddress
    },
  }),
}))

// MuHavenStableService.setOperator is invoked as the runDistribute
// pre-flight on every successful path. Resolves to a fake tx hash by
// default; tests can mockRejectedValue to simulate revert.
vi.mock('@/services/contracts/MuHavenStableService', () => ({
  setOperator: distributeStubs.setOperator,
}))

// useFhe — runner reads:
//   - initialize() (defensive in the unpause/kyc paths; not strictly
//     required since buildWriteContext lazily inits)
//   - getEphemeralEOA() for refreshSnapshotSupplyGrant
//   - decryptSnapshotSupplyForView() for the ratePerShare compute
vi.mock('@/composables/useFhe', () => ({
  useFhe: () => ({
    initialize: distributeStubs.fheInit,
    getEphemeralEOA: () => distributeStubs.ephemeralEOA,
    decryptSnapshotSupplyForView: distributeStubs.decryptSnapshotSupplyForView,
  }),
}))

// SnapshotService — runner reads snapshotProxyFor + detectInFlight +
// loadAllHolders + refreshSnapshotSupplyGrant + getEpochTotalSupplyHandle.
vi.mock('@/services/v35/SnapshotService', () => ({
  snapshotProxyFor: distributeStubs.snapshotProxyFor,
  detectInFlight: distributeStubs.detectInFlight,
  loadAllHolders: distributeStubs.loadAllHolders,
  refreshSnapshotSupplyGrant: distributeStubs.refreshSnapshotSupplyGrant,
  getEpochTotalSupplyHandle: distributeStubs.getEpochTotalSupplyHandle,
}))

// YieldSnapshotClient constructor is called to drive the on-chain
// pipeline. The constructor stub records the (ctx, address) call; the
// returned instance has openEpoch / snapshotAll / finalizeSnapshot /
// fundEpoch backed by per-test stubs.
// SubscriptionClient stays un-mocked here — runBuy isn't tested in this
// file and the import is tree-shaken on the runDistribute path.
// RATE_SCALE + tokenRegistryAbi pass through from actual exports.
vi.mock('@muhaven/sdk', async () => {
  const actual = await vi.importActual<typeof import('@muhaven/sdk')>('@muhaven/sdk')
  return {
    ...actual,
    YieldSnapshotClient: vi.fn().mockImplementation((ctx: unknown, addr: unknown) => {
      distributeStubs.yieldSnapshotClientCtor(ctx, addr)
      return {
        openEpoch: distributeStubs.openEpochFn,
        snapshotAll: distributeStubs.snapshotAllFn,
        finalizeSnapshot: distributeStubs.finalizeSnapshotFn,
        fundEpoch: distributeStubs.fundEpochFn,
      }
    }),
  }
})

// The context module's other exports (`buildReadContext`, `getPublicClient`)
// aren't touched by the P7 runner — only `buildWriteContext` matters.
// Mock it per-test via `vi.mocked(buildWriteContext).mockResolvedValueOnce(...)`.
vi.mock('@/services/v35/context', () => ({
  buildWriteContext: vi.fn(),
}))

import { buildWriteContext } from '@/services/v35/context'
import { runAgentAction } from '../useAgentActionRunner'
import { useAgentDistributeProgress } from '@/composables/useAgentDistributeProgress'

interface FakeSender {
  address: `0x${string}`
  getChainId: () => Promise<number>
  write: ReturnType<typeof vi.fn>
}

function makeContext(write: FakeSender['write']) {
  const sender: FakeSender = {
    address: '0x0000000000000000000000000000000000000001',
    getChainId: async () => 421614,
    write,
  }
  return {
    publicClient: {} as never,
    sender,
    cofheClient: {} as never,
  }
}

const TOKEN_REGISTRY = '0x4915E9Aa034244e299fb1609792D66b9fFAbf885' as const
const KYC_ADAPTER = '0x9999999999999999999999999999999999999999' as const
const TOKEN = '0x8d77ccf0a3a56c976a7deae59af1d27f27407b0d' as const
const INVESTOR = '0x2e6c694f9abdd1ec4a0b271604f79dc587811168' as const
const TX_HASH_1 = ('0x' + 'aa'.repeat(32)) as `0x${string}`
const TX_HASH_2 = ('0x' + 'bb'.repeat(32)) as `0x${string}`

function unpauseDescriptor(): ActionDescriptor {
  return {
    kind: 'unpause_token',
    toolCallId: 'tc_test_unpause',
    confirmTokenId: 'ct_test_unpause',
    expiresAtSec: Math.floor(Date.now() / 1000) + 300,
    summary: 'Unpause TESTRUN2',
    preview: {
      tokenAddress: TOKEN,
      tokenSymbol: 'TESTRUN2',
      initialNavUsd6: '1000000',
      issuerOracleAddress: '0xD30069114dFC83C714B04d6036dEfa64d2E9d583',
      tokenRegistryAddress: TOKEN_REGISTRY,
      navPublishTxHash: ('0x' + 'cc'.repeat(32)),
      requestedAtSec: Math.floor(Date.now() / 1000),
    },
    sdkCall: {
      contractName: 'TokenRegistry',
      functionName: 'setPaused',
      args: {
        tokenRegistry: TOKEN_REGISTRY,
        token: TOKEN,
        paused: false,
        txs: [
          {
            contract: 'TokenRegistry',
            address: TOKEN_REGISTRY,
            fn: 'setPaused',
            args: { token: TOKEN, paused: false },
          },
        ],
      },
    },
  }
}

function kycAddTier1Descriptor(): ActionDescriptor {
  return {
    kind: 'kyc_add',
    toolCallId: 'tc_test_kyc_add_t1',
    confirmTokenId: 'ct_test_kyc_add_t1',
    expiresAtSec: Math.floor(Date.now() / 1000) + 300,
    summary: 'Add investor to KYC tier 1',
    preview: {
      tokenAddress: TOKEN,
      tokenSymbol: 'TESTRUN2',
      investorAddress: INVESTOR,
      kycTier: 1,
      kycAdapterAddress: KYC_ADAPTER,
      requestedAtSec: Math.floor(Date.now() / 1000),
    },
    sdkCall: {
      contractName: 'ERC3643KYCAdapter',
      functionName: 'kycAddSequence',
      args: {
        adapter: KYC_ADAPTER,
        account: INVESTOR,
        kycTier: 1,
        txs: [
          {
            contract: 'ERC3643KYCAdapter',
            address: KYC_ADAPTER,
            fn: 'addToWhitelist',
            args: { account: INVESTOR },
          },
        ],
      },
    },
  }
}

function kycAddTier2Descriptor(): ActionDescriptor {
  return {
    kind: 'kyc_add',
    toolCallId: 'tc_test_kyc_add_t2',
    confirmTokenId: 'ct_test_kyc_add_t2',
    expiresAtSec: Math.floor(Date.now() / 1000) + 300,
    summary: 'Add investor to KYC tier 2',
    preview: {
      tokenAddress: TOKEN,
      tokenSymbol: 'TESTRUN2',
      investorAddress: INVESTOR,
      kycTier: 2,
      kycAdapterAddress: KYC_ADAPTER,
      requestedAtSec: Math.floor(Date.now() / 1000),
    },
    sdkCall: {
      contractName: 'ERC3643KYCAdapter',
      functionName: 'kycAddSequence',
      args: {
        adapter: KYC_ADAPTER,
        account: INVESTOR,
        kycTier: 2,
        txs: [
          {
            contract: 'ERC3643KYCAdapter',
            address: KYC_ADAPTER,
            fn: 'addToWhitelist',
            args: { account: INVESTOR },
          },
          {
            contract: 'ERC3643KYCAdapter',
            address: KYC_ADAPTER,
            fn: 'addToAccreditedList',
            args: { account: INVESTOR },
          },
        ],
      },
    },
  }
}

function kycRemoveDescriptor(): ActionDescriptor {
  return {
    kind: 'kyc_remove',
    toolCallId: 'tc_test_kyc_remove',
    confirmTokenId: 'ct_test_kyc_remove',
    expiresAtSec: Math.floor(Date.now() / 1000) + 300,
    summary: 'Remove investor from KYC',
    preview: {
      tokenAddress: TOKEN,
      tokenSymbol: 'TESTRUN2',
      investorAddress: INVESTOR,
      kycAdapterAddress: KYC_ADAPTER,
      requestedAtSec: Math.floor(Date.now() / 1000),
    },
    sdkCall: {
      contractName: 'ERC3643KYCAdapter',
      functionName: 'removeFromWhitelist',
      args: {
        adapter: KYC_ADAPTER,
        account: INVESTOR,
        txs: [
          {
            contract: 'ERC3643KYCAdapter',
            address: KYC_ADAPTER,
            fn: 'removeFromWhitelist',
            args: { account: INVESTOR },
          },
        ],
      },
    },
  }
}

describe('runAgentAction — P7 issuer dispatcher (Phase 1)', () => {
  beforeEach(() => {
    vi.mocked(buildWriteContext).mockReset()
  })

  describe('unpause_token', () => {
    it('dispatches a single TokenRegistry.setPaused tx with positional (token, paused)', async () => {
      const write = vi.fn().mockResolvedValue(TX_HASH_1)
      vi.mocked(buildWriteContext).mockResolvedValue(makeContext(write))

      const result = await runAgentAction(unpauseDescriptor())

      expect(result).toEqual({ ok: true, txHash: TX_HASH_1 })
      expect(write).toHaveBeenCalledTimes(1)
      expect(write).toHaveBeenCalledWith({
        address: TOKEN_REGISTRY,
        abi: expect.any(Array),
        functionName: 'setPaused',
        args: [TOKEN, false],
      })
    })

    it('encodes the setPaused ABI with named inputs (token, paused) so viem positional binding is stable across SDK upgrades', async () => {
      // Hardening assertion added per Code Reviewer suggestion 2026-05-19.
      // Catches the silent failure mode where a viem upgrade or ABI map
      // refactor reorders the function inputs — viem encodes by position,
      // so a swap would silently produce the wrong calldata.
      const write = vi.fn().mockResolvedValue(TX_HASH_1)
      vi.mocked(buildWriteContext).mockResolvedValue(makeContext(write))

      await runAgentAction(unpauseDescriptor())

      const call = write.mock.calls[0][0] as { abi: ReadonlyArray<Record<string, unknown>> }
      const fn = call.abi[0] as { inputs: Array<{ name: string; type: string }> }
      expect(fn.inputs.map((i) => i.name)).toEqual(['token', 'paused'])
      expect(fn.inputs.map((i) => i.type)).toEqual(['address', 'bool'])
    })
  })

  describe('kyc_add', () => {
    it('tier 1 dispatches a single addToWhitelist(account)', async () => {
      const write = vi.fn().mockResolvedValue(TX_HASH_1)
      vi.mocked(buildWriteContext).mockResolvedValue(makeContext(write))

      const result = await runAgentAction(kycAddTier1Descriptor())

      expect(result).toEqual({ ok: true, txHash: TX_HASH_1 })
      expect(write).toHaveBeenCalledTimes(1)
      expect(write).toHaveBeenCalledWith({
        address: KYC_ADAPTER,
        abi: expect.any(Array),
        functionName: 'addToWhitelist',
        args: [INVESTOR],
      })
    })

    it('tier 2 dispatches BOTH txs in order and returns the LAST hash', async () => {
      const write = vi
        .fn()
        .mockResolvedValueOnce(TX_HASH_1)
        .mockResolvedValueOnce(TX_HASH_2)
      vi.mocked(buildWriteContext).mockResolvedValue(makeContext(write))

      const result = await runAgentAction(kycAddTier2Descriptor())

      expect(result).toEqual({ ok: true, txHash: TX_HASH_2 })
      expect(write).toHaveBeenCalledTimes(2)
      expect(write.mock.calls[0][0]).toMatchObject({
        functionName: 'addToWhitelist',
        args: [INVESTOR],
      })
      expect(write.mock.calls[1][0]).toMatchObject({
        functionName: 'addToAccreditedList',
        args: [INVESTOR],
      })
    })

    it('tier 2 with mid-loop revert surfaces "step 2/2" error including (contract.fn)', async () => {
      const write = vi
        .fn()
        .mockResolvedValueOnce(TX_HASH_1)
        .mockRejectedValueOnce(new Error('execution reverted: AccountNotWhitelisted()'))
      vi.mocked(buildWriteContext).mockResolvedValue(makeContext(write))

      const result = await runAgentAction(kycAddTier2Descriptor())

      expect(result.ok).toBe(false)
      if (result.ok === false) {
        expect(result.error).toContain('kyc_add step 2/2')
        expect(result.error).toContain('ERC3643KYCAdapter.addToAccreditedList')
        expect(result.error).toContain('AccountNotWhitelisted')
      }
      // First tx still ran — by design (no on-chain rollback per-UserOp).
      expect(write).toHaveBeenCalledTimes(2)
    })
  })

  describe('kyc_remove', () => {
    it('dispatches a single removeFromWhitelist(account)', async () => {
      const write = vi.fn().mockResolvedValue(TX_HASH_1)
      vi.mocked(buildWriteContext).mockResolvedValue(makeContext(write))

      const result = await runAgentAction(kycRemoveDescriptor())

      expect(result).toEqual({ ok: true, txHash: TX_HASH_1 })
      expect(write).toHaveBeenCalledTimes(1)
      expect(write).toHaveBeenCalledWith({
        address: KYC_ADAPTER,
        abi: expect.any(Array),
        functionName: 'removeFromWhitelist',
        args: [INVESTOR],
      })
    })
  })

  describe('shape guards', () => {
    it('returns { ok: false } when sdkCall.args.txs[] is missing', async () => {
      const write = vi.fn()
      vi.mocked(buildWriteContext).mockResolvedValue(makeContext(write))

      const bad = unpauseDescriptor()
      // Strip the txs field — backend would never mint this but defense-in-depth.
      ;(bad.sdkCall.args as Record<string, unknown>).txs = undefined

      const result = await runAgentAction(bad)

      expect(result.ok).toBe(false)
      if (result.ok === false) {
        expect(result.error).toContain('missing sdkCall.args.txs')
      }
      expect(write).not.toHaveBeenCalled()
    })

    it('returns { ok: false } when txs[] is an empty array', async () => {
      const write = vi.fn()
      vi.mocked(buildWriteContext).mockResolvedValue(makeContext(write))

      const bad = unpauseDescriptor()
      ;(bad.sdkCall.args as { txs: unknown[] }).txs = []

      const result = await runAgentAction(bad)
      expect(result.ok).toBe(false)
      if (result.ok === false) {
        expect(result.error).toContain('missing sdkCall.args.txs')
      }
      expect(write).not.toHaveBeenCalled()
    })

    it('returns { ok: false } on malformed tx entry (missing address)', async () => {
      const write = vi.fn()
      vi.mocked(buildWriteContext).mockResolvedValue(makeContext(write))

      const bad = unpauseDescriptor()
      ;(bad.sdkCall.args as { txs: unknown[] }).txs = [
        { contract: 'TokenRegistry', fn: 'setPaused', args: {} },
      ]

      const result = await runAgentAction(bad)
      expect(result.ok).toBe(false)
      if (result.ok === false) {
        expect(result.error).toContain('malformed shape')
      }
      expect(write).not.toHaveBeenCalled()
    })

    it('returns { ok: false } on unknown (contract, fn) pair', async () => {
      // Post-H-2: the allowlist gate fires BEFORE the ABI resolver, so an
      // unknown (contract, fn) hits the kind-allowlist error first. The
      // "no P7 ABI registered" message is now only reachable if a future
      // tool adds an entry to P7_ALLOWED_BY_KIND without a matching
      // resolveP7Tx binding — a developer-time mistake the H-2 message
      // doesn't cover. Test the allowlist path here; the ABI-map
      // completeness is enforced by tsc on resolveP7Tx's call sites.
      const write = vi.fn()
      vi.mocked(buildWriteContext).mockResolvedValue(makeContext(write))

      const bad = unpauseDescriptor()
      ;(bad.sdkCall.args as { txs: unknown[] }).txs = [
        {
          contract: 'TokenRegistry',
          address: TOKEN_REGISTRY,
          fn: 'someFutureFn',
          args: {},
        },
      ]

      const result = await runAgentAction(bad)
      expect(result.ok).toBe(false)
      if (result.ok === false) {
        expect(result.error).toContain('not in the allowlist for this action kind')
        expect(result.error).toContain('TokenRegistry.someFutureFn')
      }
      expect(write).not.toHaveBeenCalled()
    })
  })

  describe('default branch', () => {
    it('returns "Unknown action kind" for an unrecognised kind', async () => {
      const bad = {
        kind: 'governance_propose',
        toolCallId: 'tc_test',
        confirmTokenId: 'ct_test',
        expiresAtSec: Math.floor(Date.now() / 1000) + 300,
        summary: 'unknown',
        preview: {},
        sdkCall: { contractName: 'x', functionName: 'y', args: {} },
      } as unknown as ActionDescriptor

      const result = await runAgentAction(bad)
      expect(result.ok).toBe(false)
      if (result.ok === false) {
        expect(result.error).toContain('Unknown action kind: governance_propose')
      }
    })
  })

  describe('Security review hardening (2026-05-19)', () => {
    /**
     * Regression coverage for H-1 (address binding), H-2 (kind→fn
     * allowlist), and M-1 (malformed-address rejection). Catches the
     * exact attack shapes the Security Engineer review surfaced before
     * the per-kind allowlist + preview-bound address check landed.
     */

    describe('H-1: tx.address must match preview-pinned address', () => {
      it('rejects an attacker-controlled tx.address even if shape is valid', async () => {
        const write = vi.fn()
        vi.mocked(buildWriteContext).mockResolvedValue(makeContext(write))

        const bad = unpauseDescriptor()
        // Replace the address in the tx but leave the preview's pinned
        // tokenRegistryAddress intact — exactly what a malicious server
        // would do to redirect the kernel signature to a lookalike contract.
        ;(bad.sdkCall.args as { txs: Array<Record<string, unknown>> }).txs = [
          {
            contract: 'TokenRegistry',
            address: '0xdEAD00000000000000000000000000000000dEAD',
            fn: 'setPaused',
            args: { token: TOKEN, paused: false },
          },
        ]

        const result = await runAgentAction(bad)

        expect(result.ok).toBe(false)
        if (result.ok === false) {
          expect(result.error).toContain('does not match preview-pinned')
          expect(result.error).toContain('TokenRegistry')
        }
        expect(write).not.toHaveBeenCalled()
      })

      it('rejects a kyc_add tx whose address ≠ preview.kycAdapterAddress', async () => {
        const write = vi.fn()
        vi.mocked(buildWriteContext).mockResolvedValue(makeContext(write))

        const bad = kycAddTier1Descriptor()
        ;(bad.sdkCall.args as { txs: Array<Record<string, unknown>> }).txs = [
          {
            contract: 'ERC3643KYCAdapter',
            address: '0xdEAD00000000000000000000000000000000dEAD',
            fn: 'addToWhitelist',
            args: { account: INVESTOR },
          },
        ]

        const result = await runAgentAction(bad)

        expect(result.ok).toBe(false)
        if (result.ok === false) {
          expect(result.error).toContain('does not match preview-pinned')
        }
        expect(write).not.toHaveBeenCalled()
      })

      it('rejects when the preview is missing the relevant address field', async () => {
        const write = vi.fn()
        vi.mocked(buildWriteContext).mockResolvedValue(makeContext(write))

        const bad = unpauseDescriptor()
        // Strip the preview's pinned address — without it, the runner
        // has no trusted reference to validate against.
        delete (bad.preview as Record<string, unknown>).tokenRegistryAddress

        const result = await runAgentAction(bad)

        expect(result.ok).toBe(false)
        if (result.ok === false) {
          expect(result.error).toContain('preview missing valid TokenRegistry address')
        }
        expect(write).not.toHaveBeenCalled()
      })
    })

    describe('H-2: (contract, fn) must be in allowlist for action.kind', () => {
      it('rejects kyc_remove descriptor smuggling addToWhitelist', async () => {
        const write = vi.fn()
        vi.mocked(buildWriteContext).mockResolvedValue(makeContext(write))

        const bad = kycRemoveDescriptor()
        // User sees a "Remove from whitelist" preview + authorises.
        // Malicious server ships an ADD instead. Without H-2 enforcement
        // the kernel would sign the ADD.
        ;(bad.sdkCall.args as { txs: Array<Record<string, unknown>> }).txs = [
          {
            contract: 'ERC3643KYCAdapter',
            address: KYC_ADAPTER,
            fn: 'addToWhitelist',
            args: { account: INVESTOR },
          },
        ]

        const result = await runAgentAction(bad)

        expect(result.ok).toBe(false)
        if (result.ok === false) {
          expect(result.error).toContain('not in the allowlist for this action kind')
          expect(result.error).toContain('addToWhitelist')
        }
        expect(write).not.toHaveBeenCalled()
      })

      it('rejects unpause_token descriptor smuggling setPaused-with-wrong-contract', async () => {
        const write = vi.fn()
        vi.mocked(buildWriteContext).mockResolvedValue(makeContext(write))

        const bad = unpauseDescriptor()
        // Same fn name, different contract — the (contract,fn) pair
        // "ERC3643KYCAdapter:setPaused" isn't in the allowlist.
        ;(bad.sdkCall.args as { txs: Array<Record<string, unknown>> }).txs = [
          {
            contract: 'ERC3643KYCAdapter',
            address: KYC_ADAPTER,
            fn: 'setPaused',
            args: { token: TOKEN, paused: false },
          },
        ]

        const result = await runAgentAction(bad)

        expect(result.ok).toBe(false)
        if (result.ok === false) {
          expect(result.error).toContain('not in the allowlist')
        }
        expect(write).not.toHaveBeenCalled()
      })

      it('allows kyc_add tier 2 to dispatch BOTH addToWhitelist + addToAccreditedList', async () => {
        // Companion test — confirms the allowlist isn't too restrictive.
        const write = vi
          .fn()
          .mockResolvedValueOnce(TX_HASH_1)
          .mockResolvedValueOnce(TX_HASH_2)
        vi.mocked(buildWriteContext).mockResolvedValue(makeContext(write))

        const result = await runAgentAction(kycAddTier2Descriptor())

        expect(result.ok).toBe(true)
        expect(write).toHaveBeenCalledTimes(2)
      })
    })

    describe('M-1: malformed-address shape rejection', () => {
      const cases: Array<[string, string]> = [
        ['non-hex chars', '0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'],
        ['too short', '0x1234'],
        ['too long', '0x' + 'aa'.repeat(21)],
        ['missing 0x prefix', 'aa'.repeat(20)],
      ]

      it.each(cases)('rejects %s — write never called', async (_label, badAddr) => {
        const write = vi.fn()
        vi.mocked(buildWriteContext).mockResolvedValue(makeContext(write))

        const bad = unpauseDescriptor()
        ;(bad.sdkCall.args as { txs: Array<Record<string, unknown>> }).txs = [
          {
            contract: 'TokenRegistry',
            address: badAddr,
            fn: 'setPaused',
            args: { token: TOKEN, paused: false },
          },
        ]

        const result = await runAgentAction(bad)

        expect(result.ok).toBe(false)
        if (result.ok === false) {
          expect(result.error).toContain('malformed shape')
        }
        expect(write).not.toHaveBeenCalled()
      })
    })
  })
})

// ────────────────────────────────────────────────────────────────────
// Phase 2 (rewired 2026-05-22) — distribute_yield runner against the
// Wave-3.5 YieldSnapshot pipeline. Replaces the prior Wave-3
// MuHavenClient.distributeYield wiring; the runId-tagging,
// pre-flight-no-bar, terminal-state-guard, and a11y hardening from the
// 2026-05-21 second-pass review survive intact (stage-agnostic) — the
// describe blocks below preserve every regression they covered.
// ────────────────────────────────────────────────────────────────────

const ISSUER = '0x1111111111111111111111111111111111111111' as const
const DISTRIBUTE_TOKEN = '0xaaaa000000000000000000000000000000000001' as const
const SNAPSHOT_PROXY = '0xbbbb000000000000000000000000000000000002' as const
const HOLDER_1 = '0xcccc000000000000000000000000000000000003' as `0x${string}`
const HOLDER_2 = '0xcccc000000000000000000000000000000000004' as `0x${string}`
const SUPPLY_HANDLE = ('0x' + 'ee'.repeat(32)) as `0x${string}`
const FUND_HASH = ('0x' + 'd2'.repeat(32)) as `0x${string}`
const OPEN_HASH = ('0x' + 'd0'.repeat(32)) as `0x${string}`
const SNAPSHOT_HASH = ('0x' + 'd1'.repeat(32)) as `0x${string}`
const FINALIZE_HASH = ('0x' + 'df'.repeat(32)) as `0x${string}`
const REFRESH_HASH = ('0x' + 'da'.repeat(32)) as `0x${string}`
const EPOCH_ID = 7n

function distributeDescriptor(overrides: Partial<{
  totalYieldUsd6: string
  tokenAddress: string
  issuerAddress: string
  label: string
}> = {}): ActionDescriptor {
  return {
    kind: 'distribute_yield',
    toolCallId: 'tc_test_distribute',
    confirmTokenId: 'ct_test_distribute',
    expiresAtSec: Math.floor(Date.now() / 1000) + 300,
    summary: 'Distribute $1.00 of yield across all TESTRUN2 holders.',
    preview: {
      tokenAddress: overrides.tokenAddress ?? DISTRIBUTE_TOKEN,
      tokenSymbol: 'TESTRUN2',
      totalYieldUsd6: overrides.totalYieldUsd6 ?? '1000000',
      label: overrides.label ?? 'Yield distribution for TESTRUN2',
      issuerAddress: overrides.issuerAddress ?? ISSUER,
      requestedAtSec: Math.floor(Date.now() / 1000),
    },
    sdkCall: {
      contractName: 'MuHavenClient',
      functionName: 'distributeYield',
      args: { totalYield: overrides.totalYieldUsd6 ?? '1000000' },
    },
  }
}

describe('runAgentAction — distribute_yield (P7 Phase 2 — YieldSnapshot rewire)', () => {
  beforeEach(() => {
    vi.mocked(buildWriteContext).mockReset()
    distributeStubs.kernelAddress = ISSUER
    distributeStubs.issuerTokens = [{ address: DISTRIBUTE_TOKEN }]
    distributeStubs.loadFn.mockReset()
    distributeStubs.resetFn.mockReset()
    distributeStubs.setOperator.mockReset().mockResolvedValue('0xabc')
    distributeStubs.fheInit.mockReset().mockResolvedValue(undefined)

    // YieldSnapshot pipeline defaults — happy path: proxy resolves,
    // no in-flight epoch, 2 holders, supply 2_000_000n (so $1 yield
    // gives ratePerShare = floor(1_000_000 × 1_000_000 / 2_000_000) =
    // 500_000n which is > 0).
    distributeStubs.snapshotProxyFor.mockReset().mockReturnValue(SNAPSHOT_PROXY)
    distributeStubs.detectInFlight.mockReset().mockResolvedValue(null)
    distributeStubs.loadAllHolders.mockReset().mockResolvedValue([HOLDER_1, HOLDER_2])
    distributeStubs.refreshSnapshotSupplyGrant.mockReset().mockResolvedValue(REFRESH_HASH)
    distributeStubs.getEpochTotalSupplyHandle.mockReset().mockResolvedValue(SUPPLY_HANDLE)
    distributeStubs.decryptSnapshotSupplyForView.mockReset().mockResolvedValue(2_000_000n)
    // YieldSnapshotClient instance methods.
    distributeStubs.openEpochFn.mockReset().mockResolvedValue({ epochId: EPOCH_ID, txHash: OPEN_HASH })
    distributeStubs.snapshotAllFn.mockReset().mockResolvedValue([SNAPSHOT_HASH])
    distributeStubs.finalizeSnapshotFn.mockReset().mockResolvedValue(FINALIZE_HASH)
    distributeStubs.fundEpochFn.mockReset().mockResolvedValue(FUND_HASH)
    distributeStubs.yieldSnapshotClientCtor.mockReset()
    // viem readContract for TokenRegistry.getConfig — defaults to the
    // happy path where on-chain issuer === connected kernel.
    distributeStubs.publicReadContract.mockReset().mockResolvedValue({
      issuer: ISSUER,
    })

    // Reset the module-level progress bus between tests so phase-state
    // assertions don't leak across cases.
    useAgentDistributeProgress().reset()

    const ctx = {
      publicClient: {
        readContract: distributeStubs.publicReadContract,
      } as never,
      sender: {
        address: ISSUER,
        getChainId: async () => 421614,
        write: vi.fn(),
      },
      cofheClient: { encryptInputs: vi.fn() } as never,
    }
    vi.mocked(buildWriteContext).mockResolvedValue(ctx)
  })

  it('runs the full pipeline + returns the fundEpoch tx hash', async () => {
    const result = await runAgentAction(distributeDescriptor())

    expect(result).toEqual({ ok: true, txHash: FUND_HASH })
    // Pre-flight grant fires exactly once, against the snapshot proxy.
    expect(distributeStubs.setOperator).toHaveBeenCalledTimes(1)
    expect(distributeStubs.setOperator.mock.calls[0][0]).toBe(SNAPSHOT_PROXY)
    // SDK client is constructed once with the snapshot proxy address.
    expect(distributeStubs.yieldSnapshotClientCtor).toHaveBeenCalledTimes(1)
    expect(distributeStubs.yieldSnapshotClientCtor.mock.calls[0][1]).toBe(SNAPSHOT_PROXY)
    // openEpoch called with the lowercased token address (runner
    // lowercases the preview field via readLowerAddress).
    expect(distributeStubs.openEpochFn).toHaveBeenCalledTimes(1)
    expect(distributeStubs.openEpochFn.mock.calls[0][0]).toBe(DISTRIBUTE_TOKEN)
    // snapshotAll called with the epochId + holder list.
    expect(distributeStubs.snapshotAllFn).toHaveBeenCalledTimes(1)
    expect(distributeStubs.snapshotAllFn.mock.calls[0][0]).toBe(EPOCH_ID)
    expect(distributeStubs.snapshotAllFn.mock.calls[0][1]).toEqual([HOLDER_1, HOLDER_2])
    // finalizeSnapshot called with epochId.
    expect(distributeStubs.finalizeSnapshotFn).toHaveBeenCalledTimes(1)
    expect(distributeStubs.finalizeSnapshotFn.mock.calls[0][0]).toBe(EPOCH_ID)
    // fundEpoch called with epochId, totalYield, computed ratePerShare.
    expect(distributeStubs.fundEpochFn).toHaveBeenCalledTimes(1)
    const fundArgs = distributeStubs.fundEpochFn.mock.calls[0]
    expect(fundArgs[0]).toBe(EPOCH_ID)
    expect(fundArgs[1]).toBe(1_000_000n)
    // ratePerShare = floor(1_000_000n × 1_000_000n / 2_000_000n) = 500_000n
    expect(fundArgs[2]).toBe(500_000n)
    expect(typeof fundArgs[3].onProgress).toBe('function')
  })

  it('reads TokenRegistry.getConfig.issuer + matches against the kernel', async () => {
    await runAgentAction(distributeDescriptor())
    expect(distributeStubs.publicReadContract).toHaveBeenCalledTimes(1)
    const call = distributeStubs.publicReadContract.mock.calls[0][0] as {
      functionName: string
      args: unknown[]
    }
    expect(call.functionName).toBe('getConfig')
    expect(call.args[0]).toBe(DISTRIBUTE_TOKEN)
  })

  it('progress bus advances to settled after fundEpoch resolves', async () => {
    const progress = useAgentDistributeProgress()
    await runAgentAction(distributeDescriptor())
    expect(progress.state.value.phase).toBe('settled')
  })

  it('onProgress callbacks feed the shared progress bus across the lifecycle', async () => {
    distributeStubs.openEpochFn.mockImplementation(async (_token, opts) => {
      opts?.onProgress?.({ stage: 'openEpoch', current: 1, total: 1, txHash: OPEN_HASH })
      return { epochId: EPOCH_ID, txHash: OPEN_HASH }
    })
    distributeStubs.snapshotAllFn.mockImplementation(async (_id, _holders, opts) => {
      opts?.onProgress?.({ stage: 'snapshotBatch', current: 1, total: 2, message: 'Batch 1/2' })
      opts?.onProgress?.({ stage: 'snapshotBatch', current: 2, total: 2, message: 'Batch 2/2' })
      return [SNAPSHOT_HASH, SNAPSHOT_HASH]
    })
    distributeStubs.finalizeSnapshotFn.mockImplementation(async (_id, opts) => {
      opts?.onProgress?.({ stage: 'finalizeSnapshot', current: 1, total: 1, txHash: FINALIZE_HASH })
      return FINALIZE_HASH
    })
    distributeStubs.fundEpochFn.mockImplementation(async (_id, _y, _r, opts) => {
      opts?.onProgress?.({ stage: 'encrypt', current: 0, total: 1 })
      opts?.onProgress?.({ stage: 'fundEpoch', current: 1, total: 1, txHash: FUND_HASH })
      return FUND_HASH
    })

    const progress = useAgentDistributeProgress()
    await runAgentAction(distributeDescriptor())
    expect(progress.state.value.phase).toBe('settled')
  })

  it('rejects when preview.issuerAddress does not match the connected kernel', async () => {
    distributeStubs.kernelAddress = '0x9999999999999999999999999999999999999999'
    const result = await runAgentAction(distributeDescriptor())
    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.error).toContain('does not match connected kernel')
    }
    expect(distributeStubs.setOperator).not.toHaveBeenCalled()
    expect(distributeStubs.yieldSnapshotClientCtor).not.toHaveBeenCalled()
  })

  it('rejects when preview.tokenAddress is not in the issuer-tokens store (after refresh)', async () => {
    distributeStubs.issuerTokens = []
    distributeStubs.loadFn.mockResolvedValue(undefined)
    const result = await runAgentAction(distributeDescriptor())
    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.error).toContain('not registered to this issuer kernel')
    }
    expect(distributeStubs.setOperator).not.toHaveBeenCalled()
  })

  it('accepts the action when the empty store loads in the registered token on refresh', async () => {
    distributeStubs.issuerTokens = []
    distributeStubs.loadFn.mockImplementation(async () => {
      distributeStubs.issuerTokens = [{ address: DISTRIBUTE_TOKEN }]
    })
    const result = await runAgentAction(distributeDescriptor())
    expect(result.ok).toBe(true)
    expect(distributeStubs.loadFn).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed totalYieldUsd6 BEFORE setOperator', async () => {
    const bad = distributeDescriptor()
    ;(bad.preview as Record<string, unknown>).totalYieldUsd6 = '1.5'
    const result = await runAgentAction(bad)
    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.error).toContain('valid totalYieldUsd6')
    }
    expect(distributeStubs.setOperator).not.toHaveBeenCalled()
  })

  it('rejects zero totalYieldUsd6 BEFORE setOperator', async () => {
    const result = await runAgentAction(distributeDescriptor({ totalYieldUsd6: '0' }))
    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.error).toContain('must be > 0')
    }
    expect(distributeStubs.setOperator).not.toHaveBeenCalled()
  })

  it('rejects missing preview.issuerAddress BEFORE setOperator', async () => {
    const bad = distributeDescriptor()
    delete (bad.preview as Record<string, unknown>).issuerAddress
    const result = await runAgentAction(bad)
    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.error).toContain('missing valid issuerAddress')
    }
    expect(distributeStubs.setOperator).not.toHaveBeenCalled()
  })

  it('rejects when the wallet is disconnected', async () => {
    distributeStubs.kernelAddress = null
    const result = await runAgentAction(distributeDescriptor())
    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.error).toContain('No connected kernel address')
    }
    expect(distributeStubs.setOperator).not.toHaveBeenCalled()
  })

  it('surfaces a setOperator revert as a runner error (no SDK ctor)', async () => {
    distributeStubs.setOperator.mockRejectedValue(new Error('user rejected request'))
    const result = await runAgentAction(distributeDescriptor())
    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.error).toContain('user rejected request')
    }
    expect(distributeStubs.yieldSnapshotClientCtor).not.toHaveBeenCalled()
  })

  it('case-insensitive kernel binding: mixed-case kernel still matches lowercased preview', async () => {
    distributeStubs.kernelAddress = ISSUER.toUpperCase()
    distributeStubs.publicReadContract.mockResolvedValue({ issuer: ISSUER })
    const result = await runAgentAction(
      distributeDescriptor({ issuerAddress: ISSUER }),
    )
    expect(result.ok).toBe(true)
  })

  // ── Rewire-specific pre-flight rejects ───────────────────────────

  describe('Snapshot proxy resolution (rewire pin 0)', () => {
    it('rejects when SnapshotService.snapshotProxyFor returns null', async () => {
      distributeStubs.snapshotProxyFor.mockReturnValue(null)
      const result = await runAgentAction(distributeDescriptor())
      expect(result.ok).toBe(false)
      if (result.ok === false) {
        expect(result.error).toContain('YieldSnapshot proxy not configured')
      }
      expect(distributeStubs.setOperator).not.toHaveBeenCalled()
    })

    it('rejects when SnapshotService.snapshotProxyFor returns the zero address', async () => {
      distributeStubs.snapshotProxyFor.mockReturnValue('0x0000000000000000000000000000000000000000')
      const result = await runAgentAction(distributeDescriptor())
      expect(result.ok).toBe(false)
      if (result.ok === false) {
        expect(result.error).toContain('YieldSnapshot proxy not configured')
      }
    })
  })

  describe('On-chain TokenRegistry issuer match (rewire pin 5)', () => {
    it('rejects when on-chain issuer does not match the connected kernel', async () => {
      distributeStubs.publicReadContract.mockResolvedValue({
        issuer: '0x9999999999999999999999999999999999999999',
      })
      const progress = useAgentDistributeProgress()
      const result = await runAgentAction(distributeDescriptor())
      expect(result.ok).toBe(false)
      if (result.ok === false) {
        expect(result.error).toContain('On-chain issuer')
        expect(result.error).toContain('does not match your connected kernel')
      }
      // Pre-flight failure → no UserOps fire AND bus stays idle (no
      // misleading red step-1).
      expect(distributeStubs.setOperator).not.toHaveBeenCalled()
      expect(distributeStubs.openEpochFn).not.toHaveBeenCalled()
      expect(progress.state.value.phase).toBe('idle')
    })

    it('case-insensitive: on-chain mixed-case issuer matches lowercased kernel', async () => {
      distributeStubs.publicReadContract.mockResolvedValue({
        issuer: ISSUER.toUpperCase(),
      })
      const result = await runAgentAction(distributeDescriptor())
      expect(result.ok).toBe(true)
    })
  })

  describe('In-flight epoch hand-off (rewire pin 6)', () => {
    it('returns deferred with /distribute redirect when a non-done epoch is in flight', async () => {
      distributeStubs.detectInFlight.mockResolvedValue({
        tokenAddress: DISTRIBUTE_TOKEN,
        snapshotAddress: SNAPSHOT_PROXY,
        epochId: 12n,
        epoch: {} as never,
        phase: 'snapshotting',
      })
      const progress = useAgentDistributeProgress()
      const result = await runAgentAction(distributeDescriptor())
      expect(result.ok).toBe('deferred')
      if (result.ok === 'deferred') {
        expect(result.redirectTo).toBe('/distribute')
        expect(result.reason).toContain('distribution in progress')
      }
      expect(distributeStubs.setOperator).not.toHaveBeenCalled()
      expect(distributeStubs.openEpochFn).not.toHaveBeenCalled()
      expect(progress.state.value.phase).toBe('idle')
    })

    it('RC-HIGH-1: deferred return clears bus.toolCallId (does not strand the run tag)', async () => {
      // Round-2 RC-HIGH-1: prior to the fix, the deferred return left
      // the bus tagged with this run's toolCallId at phase 'idle', so a
      // subsequent observer would see a runId belonging to a run that
      // never emitted any SDK events. The fix calls progress.reset(null)
      // on the deferred path so the bus is semantically "this run never
      // started" — same posture as a pre-flight throw.
      distributeStubs.detectInFlight.mockResolvedValue({
        tokenAddress: DISTRIBUTE_TOKEN,
        snapshotAddress: SNAPSHOT_PROXY,
        epochId: 12n,
        epoch: {} as never,
        phase: 'snapshotting',
      })
      const progress = useAgentDistributeProgress()
      const result = await runAgentAction(distributeDescriptor())
      expect(result.ok).toBe('deferred')
      // The deferred-path reset(null) clears toolCallId.
      expect(progress.state.value.toolCallId).toBeNull()
      expect(progress.state.value.phase).toBe('idle')
    })

    it('proceeds normally when detectInFlight returns null (no in-flight epoch)', async () => {
      distributeStubs.detectInFlight.mockResolvedValue(null)
      const result = await runAgentAction(distributeDescriptor())
      expect(result.ok).toBe(true)
    })

    it('proceeds normally when detectInFlight returns phase=done (prior funded epoch)', async () => {
      // currentEpoch returns the most-recent funded epoch as well; a
      // fully-completed prior distribution must NOT block a fresh one.
      distributeStubs.detectInFlight.mockResolvedValue({
        tokenAddress: DISTRIBUTE_TOKEN,
        snapshotAddress: SNAPSHOT_PROXY,
        epochId: 6n,
        epoch: {} as never,
        phase: 'done',
      })
      const result = await runAgentAction(distributeDescriptor())
      expect(result.ok).toBe(true)
    })
  })

  describe('Holder-count pre-flight (rewire pin 7)', () => {
    it('rejects when loadAllHolders returns an empty list', async () => {
      distributeStubs.loadAllHolders.mockResolvedValue([])
      const result = await runAgentAction(distributeDescriptor())
      expect(result.ok).toBe(false)
      if (result.ok === false) {
        expect(result.error).toContain('no holders')
      }
      expect(distributeStubs.setOperator).not.toHaveBeenCalled()
      expect(distributeStubs.openEpochFn).not.toHaveBeenCalled()
    })

    it('reuses the holder list as the snapshotAll input (single registry walk)', async () => {
      const holders = [HOLDER_1, HOLDER_2, '0xcccc000000000000000000000000000000000005' as `0x${string}`]
      distributeStubs.loadAllHolders.mockResolvedValue(holders)
      await runAgentAction(distributeDescriptor())
      expect(distributeStubs.loadAllHolders).toHaveBeenCalledTimes(1)
      expect(distributeStubs.snapshotAllFn.mock.calls[0][1]).toEqual(holders)
    })

    it('CR2-H2: tolerates multi-batch snapshotAll Hash[] shape', async () => {
      // Round-2 CR2-H2: the runner discards snapshotAll's return value
      // (only the onProgress events matter for the bus). Prior tests
      // mocked single-element Hash[] which would silently pass even if
      // a future SDK change altered the shape. Mock a 3-batch holder
      // run (>50 holders triggers multi-batch in real SDK) with a
      // 3-element Hash[] return + 3 onProgress events; assert the
      // runner completes correctly + the bus saw all 3 batch events.
      const manyHolders: `0x${string}`[] = Array.from({ length: 120 }, (_, i) =>
        `0xc0c0000000000000000000000000000000${i.toString(16).padStart(6, '0')}` as `0x${string}`,
      )
      distributeStubs.loadAllHolders.mockResolvedValue(manyHolders)
      const batchHashes: `0x${string}`[] = [
        ('0x' + 'b1'.repeat(32)) as `0x${string}`,
        ('0x' + 'b2'.repeat(32)) as `0x${string}`,
        ('0x' + 'b3'.repeat(32)) as `0x${string}`,
      ]
      let batchEventsSeen = 0
      distributeStubs.snapshotAllFn.mockImplementation(async (_id, _holders, opts) => {
        opts?.onProgress?.({ stage: 'snapshotBatch', current: 50, total: 120, message: 'Batch 1/3', txHash: batchHashes[0] })
        opts?.onProgress?.({ stage: 'snapshotBatch', current: 100, total: 120, message: 'Batch 2/3', txHash: batchHashes[1] })
        opts?.onProgress?.({ stage: 'snapshotBatch', current: 120, total: 120, message: 'Batch 3/3', txHash: batchHashes[2] })
        batchEventsSeen = 3
        return batchHashes
      })
      const progress = useAgentDistributeProgress()
      const result = await runAgentAction(distributeDescriptor())
      expect(result.ok).toBe(true)
      expect(batchEventsSeen).toBe(3)
      // Bus reflects the last batch event's tx hash.
      expect(progress.state.value.lastTxHash).toBe(batchHashes[2])
    })
  })

  describe('ratePerShare compute (rewire pin 14)', () => {
    it('computes floor(totalYield × RATE_SCALE / supply) and passes to fundEpoch', async () => {
      // totalYield = 25_000_000n ($25), supply = 100_000_000_000n
      // ratePerShare = floor(25_000_000n × 1_000_000n / 100_000_000_000n) = 250n
      distributeStubs.decryptSnapshotSupplyForView.mockResolvedValue(100_000_000_000n)
      const result = await runAgentAction(
        distributeDescriptor({ totalYieldUsd6: '25000000' }),
      )
      expect(result.ok).toBe(true)
      expect(distributeStubs.fundEpochFn.mock.calls[0][2]).toBe(250n)
    })

    it('rejects when ratePerShare floors to zero (totalYield too small for supply)', async () => {
      // totalYield = 1n (negligible), supply = 10_000_000_000_000_000_000n
      // floor(1n × 1_000_000n / 10_000_000_000_000_000_000n) = 0n
      distributeStubs.decryptSnapshotSupplyForView.mockResolvedValue(10_000_000_000_000_000_000n)
      const result = await runAgentAction(
        distributeDescriptor({ totalYieldUsd6: '1' }),
      )
      expect(result.ok).toBe(false)
      if (result.ok === false) {
        expect(result.error).toContain('per-share rate would round down to zero')
      }
      expect(distributeStubs.fundEpochFn).not.toHaveBeenCalled()
    })

    it('rejects when decrypted supply is zero', async () => {
      distributeStubs.decryptSnapshotSupplyForView.mockResolvedValue(0n)
      const result = await runAgentAction(distributeDescriptor())
      expect(result.ok).toBe(false)
      if (result.ok === false) {
        expect(result.error).toContain('zero supply')
      }
      expect(distributeStubs.fundEpochFn).not.toHaveBeenCalled()
    })

    it('rejects when getEpochTotalSupplyHandle returns null (finalize silent-fail)', async () => {
      distributeStubs.getEpochTotalSupplyHandle.mockResolvedValue(null)
      const result = await runAgentAction(distributeDescriptor())
      expect(result.ok).toBe(false)
      if (result.ok === false) {
        expect(result.error).toContain('Snapshot supply handle is uninitialised')
      }
      expect(distributeStubs.fundEpochFn).not.toHaveBeenCalled()
    })

    it('proceeds to decrypt + fund even when refreshSnapshotSupplyGrant fails', async () => {
      // Mirrors DistributePage.decryptSupplyFromChain pattern — a refresh
      // failure logs a warning but the decrypt is attempted anyway.
      distributeStubs.refreshSnapshotSupplyGrant.mockRejectedValue(new Error('refresh tx reverted'))
      const result = await runAgentAction(distributeDescriptor())
      expect(result.ok).toBe(true)
      expect(distributeStubs.decryptSnapshotSupplyForView).toHaveBeenCalledTimes(1)
      expect(distributeStubs.fundEpochFn).toHaveBeenCalledTimes(1)
    })

    it('RC-MED-1: setMessageForRun bridges dead window with synthetic hints', async () => {
      // Round-2 RC-MED-1: zero test coverage for the dead-window
      // bridge prior to this. Assert the message slot carries
      // "Reading encrypted supply…" while refresh+decrypt is in
      // flight, then "Computing per-share rate…" before fundEpoch.
      const progress = useAgentDistributeProgress()
      const messageObservations: Array<string | null> = []

      // Make refreshSnapshotSupplyGrant record the message at the
      // moment it's invoked — verifies setMessageForRun fired BEFORE.
      distributeStubs.refreshSnapshotSupplyGrant.mockImplementation(async () => {
        messageObservations.push(progress.state.value.message)
        return REFRESH_HASH
      })
      // fundEpoch records the message before its first onProgress fires.
      distributeStubs.fundEpochFn.mockImplementation(async (_id, _y, _r, _opts) => {
        messageObservations.push(progress.state.value.message)
        return FUND_HASH
      })

      // Drive finalizeSnapshot to emit an event so phase reaches
      // 'escrows' — required by setMessageForRun's phase guard.
      distributeStubs.finalizeSnapshotFn.mockImplementation(async (_id, opts) => {
        opts?.onProgress?.({ stage: 'finalizeSnapshot', current: 1, total: 1 })
        return FINALIZE_HASH
      })
      distributeStubs.snapshotAllFn.mockImplementation(async (_id, _holders, opts) => {
        opts?.onProgress?.({ stage: 'snapshotBatch', current: 1, total: 1 })
        return [SNAPSHOT_HASH]
      })
      distributeStubs.openEpochFn.mockImplementation(async (_token, opts) => {
        opts?.onProgress?.({ stage: 'openEpoch', current: 1, total: 1 })
        return { epochId: EPOCH_ID, txHash: OPEN_HASH }
      })

      const result = await runAgentAction(distributeDescriptor())
      expect(result.ok).toBe(true)
      // First synthetic fired before refresh; second before fundEpoch.
      expect(messageObservations[0]).toBe('Reading encrypted supply…')
      expect(messageObservations[1]).toBe('Computing per-share rate…')
    })
  })

  // ── Pre-existing semantics preserved across the rewire ───────────

  describe('SDK throw mid-pipeline marks the bus failed at the active phase', () => {
    it('flips the bus to failed when openEpoch throws AFTER emitting an event', async () => {
      distributeStubs.openEpochFn.mockImplementation(async (_token, opts) => {
        opts?.onProgress?.({ stage: 'openEpoch', current: 1, total: 1 })
        throw new Error('openEpoch reverted post-event')
      })
      const progress = useAgentDistributeProgress()
      const result = await runAgentAction(distributeDescriptor())
      expect(result.ok).toBe(false)
      expect(progress.state.value.phase).toBe('failed')
      expect(progress.state.value.failedAt).toBe('start')
    })

    it('failedAt anchors to escrows when snapshotAll throws after a batch event', async () => {
      distributeStubs.openEpochFn.mockImplementation(async (_token, opts) => {
        opts?.onProgress?.({ stage: 'openEpoch', current: 1, total: 1 })
        return { epochId: EPOCH_ID, txHash: OPEN_HASH }
      })
      distributeStubs.snapshotAllFn.mockImplementation(async (_id, _holders, opts) => {
        opts?.onProgress?.({ stage: 'snapshotBatch', current: 1, total: 2 })
        throw new Error('batch 2 reverted')
      })
      const progress = useAgentDistributeProgress()
      await runAgentAction(distributeDescriptor())
      expect(progress.state.value.phase).toBe('failed')
      expect(progress.state.value.failedAt).toBe('escrows')
    })

    it('failedAt anchors to fund when fundEpoch throws after the fundEpoch event', async () => {
      distributeStubs.openEpochFn.mockImplementation(async (_token, opts) => {
        opts?.onProgress?.({ stage: 'openEpoch', current: 1, total: 1 })
        return { epochId: EPOCH_ID, txHash: OPEN_HASH }
      })
      distributeStubs.snapshotAllFn.mockImplementation(async (_id, _holders, opts) => {
        opts?.onProgress?.({ stage: 'snapshotBatch', current: 1, total: 1 })
        return [SNAPSHOT_HASH]
      })
      distributeStubs.fundEpochFn.mockImplementation(async (_id, _y, _r, opts) => {
        opts?.onProgress?.({ stage: 'fundEpoch', current: 1, total: 1 })
        throw new Error('fundEpoch reverted')
      })
      const progress = useAgentDistributeProgress()
      await runAgentAction(distributeDescriptor())
      expect(progress.state.value.phase).toBe('failed')
      expect(progress.state.value.failedAt).toBe('fund')
    })
  })

  describe('Pre-flight failures leave the bus IDLE (no fake step-1 red bar)', () => {
    // Pre-flight throws (kernel binding mismatch, totalYield cap,
    // setOperator revert, on-chain-issuer mismatch, in-flight hand-off,
    // empty holders) happen BEFORE the SDK emits any onProgress. The
    // runner's catch checks bus phase before calling markFailed — so the
    // 3-phase bar's render-guard `phase !== 'idle'` keeps the bar HIDDEN
    // for client-side errors. User sees the standard error banner only.

    it('setOperator revert leaves bus at idle', async () => {
      distributeStubs.setOperator.mockRejectedValue(new Error('user rejected'))
      const progress = useAgentDistributeProgress()
      const result = await runAgentAction(distributeDescriptor())
      expect(result.ok).toBe(false)
      expect(progress.state.value.phase).toBe('idle')
      expect(progress.state.value.failedAt).toBeNull()
    })

    it('kernel-binding mismatch leaves bus at idle', async () => {
      distributeStubs.kernelAddress = '0x9999999999999999999999999999999999999999'
      const progress = useAgentDistributeProgress()
      const result = await runAgentAction(distributeDescriptor())
      expect(result.ok).toBe(false)
      expect(progress.state.value.phase).toBe('idle')
    })

    it('totalYield cap reject leaves bus at idle', async () => {
      const progress = useAgentDistributeProgress()
      const result = await runAgentAction(
        distributeDescriptor({ totalYieldUsd6: '18446744073709551615' }),
      )
      expect(result.ok).toBe(false)
      expect(progress.state.value.phase).toBe('idle')
    })

    it('label-length reject leaves bus at idle', async () => {
      const progress = useAgentDistributeProgress()
      const result = await runAgentAction(
        distributeDescriptor({ label: 'X'.repeat(201) }),
      )
      expect(result.ok).toBe(false)
      expect(progress.state.value.phase).toBe('idle')
    })

    it('empty-holders reject leaves bus at idle', async () => {
      distributeStubs.loadAllHolders.mockResolvedValue([])
      const progress = useAgentDistributeProgress()
      const result = await runAgentAction(distributeDescriptor())
      expect(result.ok).toBe(false)
      expect(progress.state.value.phase).toBe('idle')
    })

    it('on-chain-issuer mismatch leaves bus at idle', async () => {
      distributeStubs.publicReadContract.mockResolvedValue({
        issuer: '0x9999999999999999999999999999999999999999',
      })
      const progress = useAgentDistributeProgress()
      const result = await runAgentAction(distributeDescriptor())
      expect(result.ok).toBe(false)
      expect(progress.state.value.phase).toBe('idle')
    })
  })

  describe('Concurrent-distribution guard', () => {
    it('rejects a new distribute when the bus is mid-flight (phase=start)', async () => {
      const progress = useAgentDistributeProgress()
      const priorRunId = progress.reset('tc_prior')
      progress.applyEventForRun(priorRunId, { stage: 'openEpoch', current: 1, total: 1 })
      const result = await runAgentAction(distributeDescriptor())
      expect(result.ok).toBe(false)
      if (result.ok === false) {
        expect(result.error).toContain('previous yield distribution is still in progress')
      }
      expect(distributeStubs.setOperator).not.toHaveBeenCalled()
      expect(distributeStubs.yieldSnapshotClientCtor).not.toHaveBeenCalled()
    })

    it('allows a new distribute when the previous bus is settled', async () => {
      const progress = useAgentDistributeProgress()
      const priorRunId = progress.reset('tc_prior')
      progress.applyEventForRun(priorRunId, { stage: 'fundEpoch', current: 1, total: 1 })
      progress.markSettledForRun(priorRunId)
      const result = await runAgentAction(distributeDescriptor())
      expect(result.ok).toBe(true)
    })

    it('allows a new distribute when the previous bus failed', async () => {
      const progress = useAgentDistributeProgress()
      const priorRunId = progress.reset('tc_prior')
      progress.applyEventForRun(priorRunId, { stage: 'snapshotBatch', current: 1, total: 1 })
      progress.markFailedForRun(priorRunId)
      const result = await runAgentAction(distributeDescriptor())
      expect(result.ok).toBe(true)
    })
  })

  describe('Bus toolCallId tagging (cross-descriptor isolation)', () => {
    it('tags the bus with the descriptor toolCallId on reset', async () => {
      const progress = useAgentDistributeProgress()
      const desc = distributeDescriptor()
      await runAgentAction(desc)
      expect(progress.state.value.toolCallId).toBe(desc.toolCallId)
    })

    it('stale onProgress for the prior run is silently dropped', async () => {
      const progress = useAgentDistributeProgress()
      const staleRunId = progress.reset('tc_stale')
      progress.applyEventForRun(staleRunId, { stage: 'fundEpoch', current: 1, total: 1 })
      progress.markSettledForRun(staleRunId)

      let capturedRunId = -1
      distributeStubs.openEpochFn.mockImplementation(async (_token, opts) => {
        capturedRunId = progress.state.value.runId
        opts?.onProgress?.({ stage: 'openEpoch', current: 1, total: 1 })
        return { epochId: EPOCH_ID, txHash: OPEN_HASH }
      })
      await runAgentAction(distributeDescriptor())
      expect(capturedRunId).not.toBe(staleRunId)

      // Inject a stale-runId event AFTER the new run settled.
      progress.applyEventForRun(staleRunId, { stage: 'snapshotBatch', current: 99, total: 99 })
      expect(progress.state.value.phase).toBe('settled')
    })
  })

  describe('Security M-2: totalYield uint64 cap', () => {
    it('rejects amounts above the $100M cap', async () => {
      const result = await runAgentAction(
        distributeDescriptor({ totalYieldUsd6: '100000000000001' }),
      )
      expect(result.ok).toBe(false)
      if (result.ok === false) {
        expect(result.error).toContain('exceeds the')
        expect(result.error).toContain('cap')
      }
      expect(distributeStubs.setOperator).not.toHaveBeenCalled()
    })

    it('rejects a uint64-max amount (~$18.4T) the malicious-LLM threat shape', async () => {
      const result = await runAgentAction(
        distributeDescriptor({ totalYieldUsd6: '18446744073709551615' }),
      )
      expect(result.ok).toBe(false)
      if (result.ok === false) {
        expect(result.error).toContain('exceeds the')
      }
    })

    it('accepts amounts at exactly the cap', async () => {
      // At the $100M cap with supply=2_000_000n the ratePerShare is
      // floor(100_000_000_000_000n × 1_000_000n / 2_000_000n) =
      // 50_000_000_000_000n which is well within uint128. Happy path.
      const result = await runAgentAction(
        distributeDescriptor({ totalYieldUsd6: '100000000000000' }),
      )
      expect(result.ok).toBe(true)
    })
  })

  describe('Security M-3: label length client-side cap', () => {
    it('rejects label > 200 chars', async () => {
      const longLabel = 'A'.repeat(201)
      const result = await runAgentAction(distributeDescriptor({ label: longLabel }))
      expect(result.ok).toBe(false)
      if (result.ok === false) {
        expect(result.error).toContain('≤ 200 chars')
      }
    })

    it('rejects label that is not a string', async () => {
      const bad = distributeDescriptor()
      ;(bad.preview as Record<string, unknown>).label = 123 // wrong type
      const result = await runAgentAction(bad)
      expect(result.ok).toBe(false)
      if (result.ok === false) {
        expect(result.error).toContain('label')
      }
    })

    it('accepts a 200-char label at the cap boundary', async () => {
      const exactly200 = 'B'.repeat(200)
      const result = await runAgentAction(distributeDescriptor({ label: exactly200 }))
      expect(result.ok).toBe(true)
    })
  })
})
