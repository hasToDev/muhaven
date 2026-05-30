import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

/**
 * Wave 5 Slice 3 — per-user rebalance target allocations + drift tolerance.
 *
 * R1 decision (operator 2026-05-30): client-side localStorage v0 — keeps the
 * cutover frontend-led (no db:push, no backend deploy for storage) and is
 * trivially migratable to a backend table later. Trade-offs accepted: no
 * cross-device persistence; the agent backend can't read targets (it doesn't
 * need to — the browser computes every leg from the user's decrypt permit,
 * see `useRebalance.ts`).
 *
 * Targets are CLEARTEXT: an allocation `%` is not secret (only balances are).
 * No FHE here.
 *
 * Shape stored per wallet:
 *   { targets: { [tokenAddrLower]: bps }, toleranceBps, updatedAt }
 * where Σ targets === 10000 (100%) when configured, and `bps` is an integer
 * 0..10000. `toleranceBps` is the "already balanced" band (default 500 = 5%).
 */

/** Basis-point denominator — 100% allocation. */
export const BPS_TOTAL = 10_000
/** Default drift tolerance: 5% (operator R3 default, 2026-05-30). */
export const DEFAULT_TOLERANCE_BPS = 500
/** Tolerance is editable within a sane band so a user can't set 0% (every
 *  dust drift would churn) or >50% (rebalance would never fire). */
export const MIN_TOLERANCE_BPS = 50 // 0.5%
export const MAX_TOLERANCE_BPS = 5_000 // 50%

const STORAGE_PREFIX = 'muhaven-rebalance-targets:'

export interface StoredRebalanceTargets {
  /** Lowercased token address → target basis points (integer 0..10000). */
  targets: Record<string, number>
  /** Drift tolerance in bps (the "already balanced" band). */
  toleranceBps: number
  /** ms epoch of last save (informational only). */
  updatedAt: number
}

function storageKey(walletAddress: string): string {
  return `${STORAGE_PREFIX}${walletAddress.toLowerCase()}`
}

/**
 * Validate a (targets, tolerance) pair. Returns `null` when valid, else a
 * human-readable reason. Used by the editor before save AND by the launcher
 * before computing a plan (defense against a hand-edited localStorage blob).
 */
export function validateRebalanceTargets(
  targets: Record<string, number>,
  toleranceBps: number,
): string | null {
  const entries = Object.entries(targets)
  if (entries.length === 0) return 'Set at least one target allocation.'
  let sum = 0
  for (const [addr, bps] of entries) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) return `Invalid token address: ${addr}`
    if (!Number.isInteger(bps) || bps < 0 || bps > BPS_TOTAL) {
      return `Target for ${addr} must be an integer 0–100%.`
    }
    sum += bps
  }
  if (sum !== BPS_TOTAL) {
    return `Allocations must sum to 100% (currently ${(sum / 100).toFixed(2)}%).`
  }
  if (
    !Number.isInteger(toleranceBps) ||
    toleranceBps < MIN_TOLERANCE_BPS ||
    toleranceBps > MAX_TOLERANCE_BPS
  ) {
    return `Drift tolerance must be between ${MIN_TOLERANCE_BPS / 100}% and ${MAX_TOLERANCE_BPS / 100}%.`
  }
  return null
}

export const useRebalanceTargetsStore = defineStore('rebalanceTargets', () => {
  // Lowercased-address → bps. Empty until configured for the active wallet.
  const targets = ref<Record<string, number>>({})
  const toleranceBps = ref<number>(DEFAULT_TOLERANCE_BPS)
  const updatedAt = ref<number | null>(null)
  // The wallet whose targets are currently loaded into the refs above. Guards
  // against reading wallet A's targets after a wallet switch without a reload.
  const loadedFor = ref<string | null>(null)

  /** True iff a complete, valid target set is configured for the loaded wallet. */
  const isConfigured = computed(
    () => validateRebalanceTargets(targets.value, toleranceBps.value) === null,
  )

  /** Hydrate the refs from localStorage for `walletAddress`. Idempotent. */
  function load(walletAddress: string): void {
    const lower = walletAddress.toLowerCase()
    if (loadedFor.value === lower) return
    loadedFor.value = lower
    targets.value = {}
    toleranceBps.value = DEFAULT_TOLERANCE_BPS
    updatedAt.value = null
    try {
      const raw = localStorage.getItem(storageKey(lower))
      if (!raw) return
      const parsed = JSON.parse(raw) as Partial<StoredRebalanceTargets>
      if (parsed && typeof parsed === 'object' && parsed.targets) {
        // Re-normalise keys to lowercase defensively (a hand-edited blob or an
        // older checksum-cased write must not silently miss lookups).
        const norm: Record<string, number> = {}
        for (const [addr, bps] of Object.entries(parsed.targets)) {
          if (typeof bps === 'number') norm[addr.toLowerCase()] = bps
        }
        targets.value = norm
        if (
          typeof parsed.toleranceBps === 'number' &&
          Number.isFinite(parsed.toleranceBps)
        ) {
          toleranceBps.value = parsed.toleranceBps
        }
        updatedAt.value =
          typeof parsed.updatedAt === 'number' ? parsed.updatedAt : null
      }
    } catch (e) {
      // Corrupt blob — start fresh rather than wedging the editor.
      console.warn('[rebalanceTargets] failed to parse stored targets', e)
      targets.value = {}
      toleranceBps.value = DEFAULT_TOLERANCE_BPS
    }
  }

  /**
   * Persist a validated (targets, tolerance) set for `walletAddress`. Throws
   * with the validation reason if invalid — the caller surfaces it.
   */
  function save(
    walletAddress: string,
    nextTargets: Record<string, number>,
    nextToleranceBps: number,
  ): void {
    // Normalise to lowercase keys before validating + persisting.
    const norm: Record<string, number> = {}
    for (const [addr, bps] of Object.entries(nextTargets)) {
      norm[addr.toLowerCase()] = bps
    }
    const reason = validateRebalanceTargets(norm, nextToleranceBps)
    if (reason) throw new Error(reason)

    const lower = walletAddress.toLowerCase()
    const payload: StoredRebalanceTargets = {
      targets: norm,
      toleranceBps: nextToleranceBps,
      updatedAt: Date.now(),
    }
    localStorage.setItem(storageKey(lower), JSON.stringify(payload))
    loadedFor.value = lower
    targets.value = norm
    toleranceBps.value = nextToleranceBps
    updatedAt.value = payload.updatedAt
  }

  /** Clear the configured targets for `walletAddress` (editor "reset"). */
  function clear(walletAddress: string): void {
    const lower = walletAddress.toLowerCase()
    localStorage.removeItem(storageKey(lower))
    if (loadedFor.value === lower) {
      targets.value = {}
      toleranceBps.value = DEFAULT_TOLERANCE_BPS
      updatedAt.value = null
    }
  }

  /** Target bps for a token, or 0 if untargeted. Case-insensitive. */
  function getTargetBps(tokenAddress: string): number {
    return targets.value[tokenAddress.toLowerCase()] ?? 0
  }

  return {
    targets,
    toleranceBps,
    updatedAt,
    loadedFor,
    isConfigured,
    load,
    save,
    clear,
    getTargetBps,
  }
})
