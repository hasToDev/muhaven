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

// `useAgentActionRunner` lazy-imports `@/stores/issuer-tokens` +
// `@/stores/issuer-investors` inside `invalidateIssuerCachesAfterP7Write`.
// Pre-stub them to no-op stores so the post-dispatch cache reset doesn't
// pull Pinia into the unit-test boot path.
vi.mock('@/stores/issuer-tokens', () => ({
  useIssuerTokensStore: () => ({ reset: vi.fn() }),
}))
vi.mock('@/stores/issuer-investors', () => ({
  useIssuerInvestorsStore: () => ({ reset: vi.fn() }),
}))

// The context module's other exports (`buildReadContext`, `getPublicClient`)
// aren't touched by the P7 runner — only `buildWriteContext` matters.
// Mock it per-test via `vi.mocked(buildWriteContext).mockResolvedValueOnce(...)`.
vi.mock('@/services/v35/context', () => ({
  buildWriteContext: vi.fn(),
}))

import { buildWriteContext } from '@/services/v35/context'
import { runAgentAction } from '../useAgentActionRunner'

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
        expect(result.error).toContain('No P7 ABI registered')
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
})
