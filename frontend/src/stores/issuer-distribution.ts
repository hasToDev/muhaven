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
  /**
   * Phase 9.B / Option A — issuer's pre-computed cleartext per-share
   * yield rate. Phase 9.C / L1 (2026-05-04) — stored as `realRate ×
   * RATE_SCALE` (= `floor(totalYield × RATE_SCALE / totalSupply)` per
   * the form's compute), persisted across reloads alongside
   * totalYield. Decoded as bigint at hydrate time.
   */
  ratePerShareUnits: string
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
      // Phase 9.B / Option A — fall back to 0n for legacy persisted
      // records that pre-date the field (the wizard will refuse to
      // start runFund with rate==0, so no claim damage).
      ratePerShareUnits: BigInt(obj.ratePerShareUnits ?? '0'),
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
    ratePerShareUnits: state.ratePerShareUnits.toString(),
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
  const ratePerShareUnits = ref<bigint>(0n)  // Phase 9.B / Option A

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

  // Phase 9.C / L2 wizard split — `awaiting-fund` is a deliberate pause
  // point between Prepare and Fund, so the issuer can decrypt the
  // snapshot's supply via L2 grant + review the yield amount before
  // committing the Fund tx. Treated as NOT processing (no spinner)
  // even though the wizard is mid-flow.
  const isProcessing = computed(() =>
    phase.value !== 'idle'
    && phase.value !== 'done'
    && phase.value !== 'error'
    && phase.value !== 'awaiting-fund',
  )

  const stepperIndex = computed(() => {
    switch (phase.value) {
      case 'opening': return 0
      case 'snapshotting': return 1
      case 'finalizing': return 2
      case 'awaiting-fund': return 3   // Same column as funding — visually
      case 'funding': return 3         //   the same step (just paused vs running).
      case 'done': return 4
      default: return -1
    }
  })

  /**
   * Phase 9.C / L2 — true iff the wizard is paused at the
   * post-finalize review point, awaiting issuer Fund click. Drives
   * the page's CTA swap (Prepare → Fund) and the supply auto-decrypt
   * trigger.
   */
  const isAwaitingFund = computed(() => phase.value === 'awaiting-fund')

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
      ratePerShareUnits: ratePerShareUnits.value,
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
    ratePerShareUnits.value = persisted.ratePerShareUnits
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
      // Phase 9.C / L2 — on-chain finalize maps to 'awaiting-fund'
      // (was 'funding' pre-9.C); reconcile if sessionStorage still
      // claims a pre-finalize phase.
      if (onChain.phase === 'awaiting-fund'
          && (phase.value === 'snapshotting' || phase.value === 'finalizing')) {
        phase.value = 'awaiting-fund'
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

  /**
   * Initialise a fresh distribution. Idempotent — no on-chain side effects.
   *
   * Phase 9.C / L2 wizard split — `totalYieldUnits` and
   * `ratePerShareUnits` are now optional (default `0n`). The Prepare
   * stage doesn't need them — it runs Open + Snapshot + Finalize
   * against the holders alone. The page sets them on the store
   * before clicking Fund (via `setFundInputs`), so the Fund tx uses
   * the post-prepare values (which can incorporate the just-decrypted
   * snapshot supply).
   */
  function start(input: {
    token: Address
    snapshotAddr: Address
    totalYieldUnits?: bigint
    /**
     * Phase 9.B / Option A — issuer's pre-computed cleartext per-share
     * yield rate (`floor(totalYield × RATE_SCALE / totalSupply)`).
     * Optional at start; required by the time `runFund` is called
     * (the store guards on > 0 before sending the tx).
     */
    ratePerShareUnits?: bigint
    holderTotal: number
  }) {
    tokenAddress.value = input.token
    snapshotAddress.value = input.snapshotAddr
    epochId.value = null
    phase.value = 'preflight'
    totalYieldUnits.value = input.totalYieldUnits ?? 0n
    ratePerShareUnits.value = input.ratePerShareUnits ?? 0n
    holderTotal.value = input.holderTotal
    holderProcessed.value = 0
    batchIndex.value = 0
    batchCount.value = Math.max(1, Math.ceil(input.holderTotal / SNAPSHOT_BATCH_SIZE))
    lastTxHash.value = null
    errorMessage.value = null
    cachedHolders.value = []
  }

  /**
   * Phase 9.C / L2 wizard split — page-level setter for the Fund-stage
   * inputs. Call before `runFund` (or pass the same values as
   * `runFund` overrides). Persists immediately so a reload after the
   * issuer typed an amount but before clicking Fund preserves the
   * value across the reload.
   */
  function setFundInputs(account: Address, input: {
    totalYieldUnits: bigint
    ratePerShareUnits: bigint
  }) {
    totalYieldUnits.value = input.totalYieldUnits
    ratePerShareUnits.value = input.ratePerShareUnits
    persistIfActive(account)
  }

  /** Wipe all state. Use after success or on user-cancel. */
  function reset() {
    tokenAddress.value = null
    snapshotAddress.value = null
    epochId.value = null
    phase.value = 'idle'
    totalYieldUnits.value = 0n
    ratePerShareUnits.value = 0n
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
      // Phase 9.C / L2 wizard split — pause at awaiting-fund (was
      // 'funding'). The Fund tx now requires a separate Fund click
      // from the page after the issuer reviews the (auto-decrypted)
      // supply + the yield amount.
      phase.value = 'awaiting-fund'
      persistIfActive(account)
    } catch (e) {
      setError(account, e instanceof Error ? e.message : 'finalizeSnapshot failed')
    }
  }

  /**
   * Phase 9.C / L2 wizard split — issuer-driven Fund step. Updates the
   * per-share rate + yield amount immediately before sending the
   * fundEpoch tx, since the issuer may have changed them after the
   * supply auto-decrypted at finalize time. The store's persisted
   * `ratePerShareUnits` / `totalYieldUnits` are the authoritative
   * inputs to this step.
   */
  async function runFund(
    account: Address,
    overrides?: { totalYieldUnits?: bigint; ratePerShareUnits?: bigint },
  ) {
    if (!snapshotAddress.value || epochId.value === null) {
      setError(account, 'Fund pre-state missing')
      return
    }
    if (overrides?.totalYieldUnits !== undefined) {
      totalYieldUnits.value = overrides.totalYieldUnits
    }
    if (overrides?.ratePerShareUnits !== undefined) {
      ratePerShareUnits.value = overrides.ratePerShareUnits
    }
    if (totalYieldUnits.value <= 0n) {
      setError(account, 'Yield amount must be > 0.')
      return
    }
    if (ratePerShareUnits.value <= 0n) {
      // Phase 9.B / Option A + Phase 9.C / L1 — guardrail. Zero rate
      // would silent-fail every claim; prefer to error out at the
      // wizard layer with an actionable message instead of letting
      // `InvalidRatePerShare` bubble up from the contract.
      setError(
        account,
        'Per-share rate rounds to zero on-chain. Increase the yield amount or reduce supply.',
      )
      return
    }
    phase.value = 'funding'
    persistIfActive(account)
    try {
      const txHash = await SnapshotService.fundEpoch(
        snapshotAddress.value,
        epochId.value,
        totalYieldUnits.value,
        ratePerShareUnits.value,
      )
      lastTxHash.value = txHash
      phase.value = 'done'
      persistIfActive(account)
    } catch (e) {
      setError(account, e instanceof Error ? e.message : 'fundEpoch failed')
    }
  }

  /**
   * Phase 9.C / L2 wizard split (2026-05-04) — Stage 1: Prepare.
   * Drives Open + Snapshot + Finalize and PAUSES at awaiting-fund.
   * Replaces `runDistribution` for the brand-new-epoch path; the
   * separate `runFund` call is the Stage 2 trigger.
   *
   * Resume-aware: same phase-gated branches as `runDistribution`. A
   * resume from sessionStorage that's already past finalize will
   * no-op cleanly into awaiting-fund.
   */
  async function runPrepare(account: Address) {
    if (phase.value === 'preflight') {
      await runOpenEpoch(account)
    }
    if (phase.value === 'snapshotting') {
      await runSnapshotBatches(account)
    }
    if (phase.value === 'finalizing') {
      await runFinalize(account)
    }
    // After runFinalize, phase === 'awaiting-fund'. The page handles
    // the pause UX (auto-decrypt supply via L2, swap CTA to Fund).
  }

  /**
   * Drive the post-preflight pipeline end-to-end. Pre-9.C/L2 entry
   * point; preserved for any caller that wants the legacy single-shot
   * behaviour. New /distribute UX uses `runPrepare` + `runFund` so the
   * issuer can review the supply between stages.
   */
  async function runDistribution(account: Address) {
    await runPrepare(account)
    if (phase.value === 'awaiting-fund' || phase.value === 'funding') {
      await runFund(account)
    }
  }

  return {
    tokenAddress,
    snapshotAddress,
    epochId,
    phase,
    totalYieldUnits,
    ratePerShareUnits,
    holderTotal,
    holderProcessed,
    batchIndex,
    batchCount,
    lastTxHash,
    errorMessage,
    isProcessing,
    isAwaitingFund,
    stepperIndex,
    snapshotProgress,
    snapshot,
    hydrate,
    markPreparing,
    setError,
    start,
    setFundInputs,
    reset,
    runOpenEpoch,
    runSnapshotBatches,
    runFinalize,
    runFund,
    runPrepare,
    runDistribution,
  }
})
