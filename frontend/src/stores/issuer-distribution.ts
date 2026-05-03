/**
 * Issuer-side yield-distribution state machine (Wave 3.5 / Phase 9.A
 * /distribute rewrite). Hoists the wizard's per-phase state out of the
 * page so:
 *   - reload mid-flight resumes from on-chain state (`detectInFlight`)
 *     and a sessionStorage persist (page-tab continuity)
 *   - the page stays a thin v-model over the store
 *   - sidebar / topnav surfaces could later read in-flight epoch state
 *     without remounting /distribute
 *
 * State machine: idle → preflight → opening → snapshotting → finalizing
 * → funding → done. Failure transitions to `error` with `errorMessage`
 * preserved; `currentPhaseHistory()` retains the last-active phase so the
 * UI can offer a Retry from the failed step.
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Address, Hash } from 'viem'
import * as SnapshotService from '@/services/v35/SnapshotService'
import type {
  DistributionPhase,
  EpochInFlight,
} from '@/services/v35/SnapshotService'

export type { DistributionPhase, EpochInFlight }

const STORAGE_KEY = 'muhaven-issuer-distribution'
const SNAPSHOT_BATCH_SIZE = SnapshotService.SNAPSHOT_CONSTANTS.BATCH_SIZE

interface PersistedSnapshot {
  smartAccount: string
  tokenAddress: string
  snapshotAddress: string
  epochId: string | null   // bigint serialised as decimal string
  phase: DistributionPhase
  totalYieldUnits: string  // bigint serialised
  holderTotal: number
  holderProcessed: number
  batchIndex: number
  batchCount: number
  lastTxHash: string | null
  errorMessage: string | null
}

function loadPersisted(smartAccount: Address | null): EpochInFlight | null {
  if (!smartAccount || typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const obj = JSON.parse(raw) as PersistedSnapshot
    if (obj.smartAccount.toLowerCase() !== smartAccount.toLowerCase()) {
      // Account swap — wipe the persisted record; the new account starts
      // from idle state.
      window.sessionStorage.removeItem(STORAGE_KEY)
      return null
    }
    return {
      tokenAddress: obj.tokenAddress as Address,
      snapshotAddress: obj.snapshotAddress as Address,
      epochId: obj.epochId === null ? null : BigInt(obj.epochId),
      phase: obj.phase,
      totalYieldUnits: BigInt(obj.totalYieldUnits),
      holderTotal: obj.holderTotal,
      holderProcessed: obj.holderProcessed,
      batchIndex: obj.batchIndex,
      batchCount: obj.batchCount,
      lastTxHash: obj.lastTxHash as Hash | null,
      errorMessage: obj.errorMessage,
    }
  } catch {
    return null
  }
}

function persist(smartAccount: Address, state: EpochInFlight) {
  if (typeof window === 'undefined') return
  const obj: PersistedSnapshot = {
    smartAccount,
    tokenAddress: state.tokenAddress,
    snapshotAddress: state.snapshotAddress,
    epochId: state.epochId === null ? null : state.epochId.toString(),
    phase: state.phase,
    totalYieldUnits: state.totalYieldUnits.toString(),
    holderTotal: state.holderTotal,
    holderProcessed: state.holderProcessed,
    batchIndex: state.batchIndex,
    batchCount: state.batchCount,
    lastTxHash: state.lastTxHash,
    errorMessage: state.errorMessage,
  }
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(obj))
  } catch {
    // Storage quota / unavailable — silently degrade. The wizard still
    // works for the current page-load; only reload-resume is lost.
  }
}

function clearPersisted() {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* noop */
  }
}

export const useIssuerDistributionStore = defineStore('issuer-distribution', () => {
  const tokenAddress = ref<Address | null>(null)
  const snapshotAddress = ref<Address | null>(null)
  const epochId = ref<bigint | null>(null)
  const phase = ref<DistributionPhase>('idle')
  const totalYieldUnits = ref<bigint>(0n)

  const holderTotal = ref(0)
  const holderProcessed = ref(0)
  const batchIndex = ref(0)
  const batchCount = ref(0)

  const lastTxHash = ref<Hash | null>(null)
  const errorMessage = ref<string | null>(null)

  // Cached holder list for the current epoch — populated on entry into
  // `snapshotting` and consumed batch-by-batch. Reset on `reset()` /
  // success so the next distribution starts fresh.
  const cachedHolders = ref<Address[]>([])

  // ── Derived ──────────────────────────────────────────────────────────

  const isProcessing = computed(() =>
    phase.value !== 'idle' && phase.value !== 'done' && phase.value !== 'error',
  )

  const stepperIndex = computed(() => {
    switch (phase.value) {
      case 'opening': return 0
      case 'snapshotting': return 1
      case 'finalizing': return 2
      case 'funding': return 3
      case 'done': return 4
      default: return -1
    }
  })

  const snapshotProgress = computed(() => ({
    processed: holderProcessed.value,
    total: holderTotal.value,
    batch: batchIndex.value,
    batchCount: batchCount.value,
  }))

  const snapshot = computed<EpochInFlight | null>(() => {
    if (!tokenAddress.value || !snapshotAddress.value) return null
    return {
      tokenAddress: tokenAddress.value,
      snapshotAddress: snapshotAddress.value,
      epochId: epochId.value,
      phase: phase.value,
      totalYieldUnits: totalYieldUnits.value,
      holderTotal: holderTotal.value,
      holderProcessed: holderProcessed.value,
      batchIndex: batchIndex.value,
      batchCount: batchCount.value,
      lastTxHash: lastTxHash.value,
      errorMessage: errorMessage.value,
    }
  })

  // ── Helpers ──────────────────────────────────────────────────────────

  function persistIfActive(account: Address) {
    if (snapshot.value) persist(account, snapshot.value)
  }

  /**
   * Flip phase to `'preparing'` immediately on Distribute click, before
   * any pre-phase work runs (preflight refresh, mhUSDC decrypt, operator
   * grants, auto-wrap). Closes the click-to-feedback latency gap where
   * the CTA stayed at "Distribute · $X" with no spinner for 3-10s while
   * silent work landed UserOps. The button reads `isProcessing` (which
   * already covers any non-idle/done/error phase) and switches to
   * "Preparing…" within one tick of the click.
   *
   * No persistence — pre-phase work has no token/snapshot binding yet,
   * and `snapshot.value` is null until `start()` runs.
   */
  function markPreparing() {
    errorMessage.value = null
    phase.value = 'preparing'
  }

  function setError(account: Address, msg: string) {
    errorMessage.value = msg
    phase.value = 'error'
    persistIfActive(account)
  }

  // ── Resume on mount ──────────────────────────────────────────────────

  /**
   * Hydrate the store from sessionStorage + on-chain reads. Called on
   * /distribute mount with the connected smart-account address.
   *
   * Strategy:
   *   1. Read sessionStorage. If it has an entry for this account, hydrate.
   *   2. If hydrated state has a `tokenAddress`, query
   *      `detectInFlight(token)` and reconcile against on-chain truth —
   *      sessionStorage may be stale (e.g. user closed the tab after
   *      `funding` succeeded but before the persisted phase was written).
   *   3. If no sessionStorage but the page is mounted, we don't have a
   *      token yet — caller should call `detectInFlight` for each issuer
   *      token explicitly.
   */
  async function hydrate(smartAccount: Address) {
    const persisted = loadPersisted(smartAccount)
    if (!persisted) return

    tokenAddress.value = persisted.tokenAddress
    snapshotAddress.value = persisted.snapshotAddress
    epochId.value = persisted.epochId
    phase.value = persisted.phase
    totalYieldUnits.value = persisted.totalYieldUnits
    holderTotal.value = persisted.holderTotal
    holderProcessed.value = persisted.holderProcessed
    batchIndex.value = persisted.batchIndex
    batchCount.value = persisted.batchCount
    lastTxHash.value = persisted.lastTxHash
    errorMessage.value = persisted.errorMessage

    // Reconcile against on-chain truth — sessionStorage can be stale.
    try {
      const onChain = await SnapshotService.detectInFlight(persisted.tokenAddress)
      if (!onChain) {
        // Either the token has no epoch at all, or the snapshot proxy
        // rotated out from under us. Wipe persisted state.
        reset()
        return
      }
      // If on-chain says the epoch is funded, the wizard is done — even
      // if sessionStorage still claims `funding`.
      if (onChain.phase === 'done') {
        phase.value = 'done'
        epochId.value = onChain.epochId
        persistIfActive(smartAccount)
        return
      }
      // If on-chain says we're behind sessionStorage, prefer on-chain
      // (e.g. the epoch was finalized on another tab).
      epochId.value = onChain.epochId
      if (onChain.phase === 'funding' && phase.value === 'snapshotting') {
        phase.value = 'finalizing'  // ready for finalize tx if not yet sent
      }
      // Refresh holderProcessed from epoch.holderCount — the contract is
      // the source of truth.
      holderProcessed.value = Number(onChain.epoch.holderCount)
      persistIfActive(smartAccount)
    } catch {
      // detectInFlight failure is non-fatal — UI keeps the persisted
      // state and lets the user manually retry from there.
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /** Initialise a fresh distribution. Idempotent — no on-chain side effects. */
  function start(input: {
    token: Address
    snapshotAddr: Address
    totalYieldUnits: bigint
    holderTotal: number
  }) {
    tokenAddress.value = input.token
    snapshotAddress.value = input.snapshotAddr
    epochId.value = null
    phase.value = 'preflight'
    totalYieldUnits.value = input.totalYieldUnits
    holderTotal.value = input.holderTotal
    holderProcessed.value = 0
    batchIndex.value = 0
    batchCount.value = Math.max(1, Math.ceil(input.holderTotal / SNAPSHOT_BATCH_SIZE))
    lastTxHash.value = null
    errorMessage.value = null
    cachedHolders.value = []
  }

  /** Wipe all state. Use after success or on user-cancel. */
  function reset() {
    tokenAddress.value = null
    snapshotAddress.value = null
    epochId.value = null
    phase.value = 'idle'
    totalYieldUnits.value = 0n
    holderTotal.value = 0
    holderProcessed.value = 0
    batchIndex.value = 0
    batchCount.value = 0
    lastTxHash.value = null
    errorMessage.value = null
    cachedHolders.value = []
    clearPersisted()
  }

  // ── Phase actions ────────────────────────────────────────────────────

  async function runOpenEpoch(account: Address) {
    if (!tokenAddress.value || !snapshotAddress.value) {
      setError(account, 'Token not selected')
      return
    }
    phase.value = 'opening'
    persistIfActive(account)
    try {
      const { epochId: newId, txHash } = await SnapshotService.openEpoch(
        snapshotAddress.value,
        tokenAddress.value,
      )
      epochId.value = newId
      lastTxHash.value = txHash
      phase.value = 'snapshotting'
      persistIfActive(account)
    } catch (e) {
      setError(account, e instanceof Error ? e.message : 'openEpoch failed')
    }
  }

  /** Walk the cached holder list one batch at a time. Resumes from `batchIndex`. */
  async function runSnapshotBatches(account: Address) {
    if (!tokenAddress.value || !snapshotAddress.value || epochId.value === null) {
      setError(account, 'Snapshot pre-state missing')
      return
    }
    phase.value = 'snapshotting'
    persistIfActive(account)

    try {
      // Cache the holder list once per epoch — same list, slice by index.
      if (cachedHolders.value.length === 0) {
        cachedHolders.value = await SnapshotService.loadAllHolders(tokenAddress.value)
        holderTotal.value = cachedHolders.value.length
        batchCount.value = Math.max(
          1,
          Math.ceil(cachedHolders.value.length / SNAPSHOT_BATCH_SIZE),
        )
      }

      const batches = SnapshotService.chunkInvestors(cachedHolders.value, SNAPSHOT_BATCH_SIZE)
      // Resume: skip batches whose offset is < holderProcessed. The
      // contract's idempotency on (epochId, investor) means re-sending
      // an already-snapshotted batch is a no-op, but skipping saves gas.
      for (let i = batchIndex.value; i < batches.length; i++) {
        const batch = batches[i]
        const txHash = await SnapshotService.snapshotBatch(
          snapshotAddress.value,
          epochId.value,
          batch,
        )
        lastTxHash.value = txHash
        batchIndex.value = i + 1
        holderProcessed.value = Math.min(
          (i + 1) * SNAPSHOT_BATCH_SIZE,
          cachedHolders.value.length,
        )
        persistIfActive(account)
      }

      phase.value = 'finalizing'
      persistIfActive(account)
    } catch (e) {
      setError(account, e instanceof Error ? e.message : 'snapshotBatch failed')
    }
  }

  async function runFinalize(account: Address) {
    if (!snapshotAddress.value || epochId.value === null) {
      setError(account, 'Finalize pre-state missing')
      return
    }
    phase.value = 'finalizing'
    persistIfActive(account)
    try {
      const txHash = await SnapshotService.finalizeSnapshot(
        snapshotAddress.value,
        epochId.value,
      )
      lastTxHash.value = txHash
      phase.value = 'funding'
      persistIfActive(account)
    } catch (e) {
      setError(account, e instanceof Error ? e.message : 'finalizeSnapshot failed')
    }
  }

  async function runFund(account: Address) {
    if (!snapshotAddress.value || epochId.value === null) {
      setError(account, 'Fund pre-state missing')
      return
    }
    phase.value = 'funding'
    persistIfActive(account)
    try {
      const txHash = await SnapshotService.fundEpoch(
        snapshotAddress.value,
        epochId.value,
        totalYieldUnits.value,
      )
      lastTxHash.value = txHash
      phase.value = 'done'
      persistIfActive(account)
    } catch (e) {
      setError(account, e instanceof Error ? e.message : 'fundEpoch failed')
    }
  }

  /** Drive the post-preflight pipeline end-to-end. */
  async function runDistribution(account: Address) {
    if (phase.value === 'preflight') {
      await runOpenEpoch(account)
    }
    if (phase.value === 'snapshotting') {
      await runSnapshotBatches(account)
    }
    if (phase.value === 'finalizing') {
      await runFinalize(account)
    }
    if (phase.value === 'funding') {
      await runFund(account)
    }
  }

  return {
    tokenAddress,
    snapshotAddress,
    epochId,
    phase,
    totalYieldUnits,
    holderTotal,
    holderProcessed,
    batchIndex,
    batchCount,
    lastTxHash,
    errorMessage,
    isProcessing,
    stepperIndex,
    snapshotProgress,
    snapshot,
    hydrate,
    markPreparing,
    setError,
    start,
    reset,
    runOpenEpoch,
    runSnapshotBatches,
    runFinalize,
    runFund,
    runDistribution,
  }
})
