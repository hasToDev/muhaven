/**
 * Issuer-side yield-distribution helpers (Wave 3.5 / Phase 9.A · /distribute
 * rewrite). Wraps the `YieldSnapshotClient` lifecycle behind two surfaces:
 *
 *   1. `preflight(...)`   — read-only assessment of what needs to happen
 *                            before a distribution can run (mhUSDC balance,
 *                            two operator approvals, wrap-needed delta).
 *   2. `detectInFlight()`  — discover any in-flight epoch from on-chain
 *                            state and classify into a UI phase. Used by
 *                            the resume path on /distribute mount.
 *
 * The wizard composes these with the SDK's existing per-step methods
 * (`openEpoch`, `snapshotBatch`, `finalizeSnapshot`, `fundEpoch`) directly
 * — no `runDistribution` orchestrator is exposed because the store needs
 * fine-grained control to mark phases atomic with on-chain receipts (and
 * to skip steps that already landed on a resume).
 *
 * Replaces the runbook in `scripts/run-yield-epoch.ts` for production-shape
 * UX. The script stays as an ops fallback (per user instruction) until the
 * dashboard flow is verified end-to-end on a live demo.
 */

import type { Address, Hash } from 'viem'
import { YieldSnapshotClient, StableClient, tokenRegistryAbi, type EpochView } from '@muhaven/sdk'
import { v35Addresses, isZeroAddress } from '@/contracts/addresses'
import { buildReadContext, buildWriteContext, getPublicClient } from '@/services/v35/context'
import * as MuHavenStableService from '@/services/contracts/MuHavenStableService'
import * as LegacyPusdcService from '@/services/contracts/LegacyPusdcService'
import * as RegistryService from '@/services/contracts/RegistryService'

const SNAPSHOT_BATCH_SIZE = 50
/** 1y operator-approval TTL — matches the script default. */
const OPERATOR_EXPIRY_SECONDS = 365 * 24 * 60 * 60

/** Phases a distribution moves through, end-to-end. */
export type DistributionPhase =
  | 'idle'
  | 'preflight'      // balance check + 2 operator approvals + auto-wrap
  | 'opening'        // openEpoch tx in flight
  | 'snapshotting'   // batched; carries (current, total) progress
  | 'finalizing'
  | 'funding'        // encrypt amount + fundEpoch
  | 'done'
  | 'error'

/** Snapshot-of-state for an in-flight or completed epoch. */
export interface EpochInFlight {
  tokenAddress: Address
  snapshotAddress: Address
  epochId: bigint | null            // null until openEpoch lands
  phase: DistributionPhase
  totalYieldUnits: bigint            // 6-decimal mhUSDC base units
  // Snapshot progress
  holderTotal: number
  holderProcessed: number
  batchIndex: number
  batchCount: number
  // Tx + error trace
  lastTxHash: Hash | null
  errorMessage: string | null
}

export interface PreflightStatus {
  /** Issuer's encrypted mhUSDC balance handle (ctHash). */
  mhUsdcHandle: `0x${string}`
  /** Decrypted mhUSDC balance — only populated after a Reveal click. */
  mhUsdcBalance: bigint | null
  /** True iff `legacyPusdc.isOperator(issuer, mhUSDC) == true`. */
  legacyToWrapperOperatorOk: boolean
  /** True iff `mhUSDC.isOperator(issuer, snapshotProxy) == true`. */
  wrapperToSnapshotOperatorOk: boolean
  /** Holder count for the selected token. */
  holderCount: number
  /**
   * The on-chain issuer registered for this token, read from
   * `TokenRegistry.getConfig(token).issuer`. The connected kernel must
   * match this exactly — every YieldSnapshot write checks
   * `msg.sender == _issuerOf(token)` and reverts `OnlyIssuer()` (selector
   * `0x55b51ef1`) on mismatch. Surface this in the UI before submission
   * so the user gets an actionable error instead of a cryptic revert.
   */
  onChainIssuer: Address
  /** True iff the connected kernel === `onChainIssuer`. */
  callerIsOnChainIssuer: boolean
}

export interface InFlightSnapshot {
  tokenAddress: Address
  snapshotAddress: Address
  epochId: bigint
  epoch: EpochView
  phase: Extract<DistributionPhase, 'snapshotting' | 'finalizing' | 'funding' | 'done'>
}

// ── Resolution helpers ─────────────────────────────────────────────────

/**
 * Look up the YieldSnapshot proxy for a given token. Wave 3.5 maps each
 * RWA token to a snapshot proxy; staging shares one proxy across multiple
 * tokens, but the lookup is keyed by token address so consumers don't
 * have to know which proxy hosts which token.
 */
export function snapshotProxyFor(token: Address): Address | null {
  const proxy = v35Addresses.yieldSnapshots[token.toLowerCase()] ?? null
  if (!proxy || isZeroAddress(proxy)) return null
  return proxy as Address
}

// ── Preflight ──────────────────────────────────────────────────────────

/**
 * Read-only preflight. Returns everything the wizard needs to know before
 * the issuer commits to a distribution:
 *   - mhUSDC handle (and a decrypted balance if the caller already has it)
 *   - both operator approvals' state
 *   - per-token holder count
 *
 * Reading `mhUsdcBalance: bigint | null` rather than the plaintext spares
 * the issuer a passkey for the preflight read; the UI can opt-in decrypt
 * via a Reveal button.
 */
export async function preflight(
  issuer: Address,
  token: Address,
): Promise<PreflightStatus> {
  const snapshotAddr = snapshotProxyFor(token)
  if (!snapshotAddr) {
    throw new Error(`No YieldSnapshot proxy configured for token ${token}`)
  }

  const [
    mhUsdcHandle,
    legacyToWrapperOperatorOk,
    wrapperToSnapshotOperatorOk,
    rawHolderCount,
    tokenConfig,
  ] = await Promise.all([
    MuHavenStableService.confidentialBalanceOf(issuer),
    LegacyPusdcService.isOperator(issuer, v35Addresses.muHavenStable),
    MuHavenStableService.isOperator(issuer, snapshotAddr),
    RegistryService.holderCount(token),
    readTokenRegistryConfig(token),
  ])

  const onChainIssuer = tokenConfig.issuer as Address
  const callerIsOnChainIssuer =
    onChainIssuer.toLowerCase() === issuer.toLowerCase()

  return {
    mhUsdcHandle,
    mhUsdcBalance: null,
    legacyToWrapperOperatorOk,
    wrapperToSnapshotOperatorOk,
    holderCount: Number(rawHolderCount),
    onChainIssuer,
    callerIsOnChainIssuer,
  }
}

/**
 * Read `TokenRegistry.getConfig(token)` directly via viem. The SDK
 * doesn't ship a TokenRegistryClient yet (read-only surface only), so
 * we use the abi + a plain `readContract` call. Used by `preflight` to
 * surface the `OnlyIssuer()` mismatch path early, before the user
 * submits a guaranteed-failing UserOp.
 */
interface TokenRegistryConfig {
  active: boolean
  treasury: string
  queue: string
  oracle: string
  issuer: string
  minInvestment: bigint
  instantRedeemCap: bigint
  epochDuration: number
  paused: boolean
}

async function readTokenRegistryConfig(token: Address): Promise<TokenRegistryConfig> {
  const client = getPublicClient()
  return (await client.readContract({
    address: v35Addresses.tokenRegistry,
    abi: tokenRegistryAbi,
    functionName: 'getConfig',
    args: [token],
  })) as unknown as TokenRegistryConfig
}

// ── Operator grants ────────────────────────────────────────────────────

/** Compute a 1y unix-second expiry from now. */
function operatorExpiry(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + OPERATOR_EXPIRY_SECONDS)
}

/**
 * Grant `legacyPusdc → mhUSDC` operator approval. Required only when the
 * issuer needs to wrap legacy PUSDC into mhUSDC (under-funded case). The
 * dashboard-facing label for this step is "Authorize cash wrapper" — the
 * underlying wiring is intentionally hidden from issuer-facing copy.
 */
export async function grantLegacyToWrapperOperator(): Promise<Hash> {
  return LegacyPusdcService.setOperator(
    v35Addresses.muHavenStable,
    operatorExpiry(),
  ) as Promise<Hash>
}

/**
 * Grant `mhUSDC → snapshotProxy` operator approval. Required for every
 * distribution; expires after 1y so re-running on day 366 needs a fresh
 * grant. Without this, fundEpoch's pull silent-fails to zero (per the
 * blocker note in `scripts/run-yield-epoch.ts`'s preflight wrap comment).
 */
export async function grantWrapperToSnapshotOperator(
  snapshotAddr: Address,
): Promise<Hash> {
  return MuHavenStableService.setOperator(
    snapshotAddr,
    operatorExpiry(),
  ) as Promise<Hash>
}

// ── Auto-wrap ──────────────────────────────────────────────────────────

/**
 * Wrap `amount` legacy PUSDC into mhUSDC for the issuer. Pulls legacy
 * PUSDC via the wrapper's operator path. Caller must have already granted
 * `legacyPusdc.setOperator(mhUSDC, ...)` via `grantLegacyToWrapperOperator`.
 *
 * Used inline in the preflight phase when the issuer's mhUSDC balance is
 * short of the requested totalYield. Idempotent in effect — over-wrapping
 * just accumulates the issuer's mhUSDC float.
 */
export async function autoWrapForDistribution(
  amount: bigint,
  ephemeralEOA: Address,
): Promise<Hash> {
  const ctx = await buildWriteContext()
  const stable = new StableClient(ctx, v35Addresses.muHavenStable)
  return stable.wrap(amount, ephemeralEOA)
}

// ── Per-step wrappers ──────────────────────────────────────────────────

/**
 * Open a new epoch for `token`. Returns the parsed `epochId` from the
 * SDK's receipt parsing. The calling store must persist this id before
 * advancing to snapshotting — without it, a reload mid-batch can't resume.
 */
export async function openEpoch(
  snapshotAddr: Address,
  token: Address,
): Promise<{ epochId: bigint; txHash: Hash }> {
  const ctx = await buildWriteContext()
  const client = new YieldSnapshotClient(ctx, snapshotAddr)
  return client.openEpoch(token)
}

/**
 * Snapshot a single batch of investors. The caller controls pagination so
 * resume-mid-flight works cleanly: persist `(batchIndex, batchCount)` per
 * tx, walk the list slice-by-slice from the store.
 */
export async function snapshotBatch(
  snapshotAddr: Address,
  epochId: bigint,
  investors: Address[],
): Promise<Hash> {
  const ctx = await buildWriteContext()
  const client = new YieldSnapshotClient(ctx, snapshotAddr)
  return client.snapshotBatch(epochId, investors)
}

export async function finalizeSnapshot(
  snapshotAddr: Address,
  epochId: bigint,
): Promise<Hash> {
  const ctx = await buildWriteContext()
  const client = new YieldSnapshotClient(ctx, snapshotAddr)
  return client.finalizeSnapshot(epochId)
}

export async function fundEpoch(
  snapshotAddr: Address,
  epochId: bigint,
  totalYield: bigint,
): Promise<Hash> {
  const ctx = await buildWriteContext()
  const client = new YieldSnapshotClient(ctx, snapshotAddr)
  return client.fundEpoch(epochId, totalYield)
}

// ── Holder enumeration ─────────────────────────────────────────────────

/**
 * Walk the registry's per-token holder list to completion. Reads in
 * `SNAPSHOT_BATCH_SIZE` chunks. Caller (the store) caches the result
 * keyed by `(token, openEpoch-block)` so a reload mid-batch replays the
 * exact same list to the contract. The contract dedupes per-investor
 * anyway, so re-sending matters mostly for progress-math honesty.
 */
export async function loadAllHolders(token: Address): Promise<Address[]> {
  const total = Number(await RegistryService.holderCount(token))
  if (total === 0) return []

  const chunks: Address[][] = []
  for (let offset = 0; offset < total; offset += SNAPSHOT_BATCH_SIZE) {
    const limit = Math.min(SNAPSHOT_BATCH_SIZE, total - offset)
    const slice = await RegistryService.getHoldersPaginated(
      token,
      BigInt(offset),
      BigInt(limit),
    )
    chunks.push(slice)
  }
  return chunks.flat()
}

/** Group an investor list into snapshotBatch-sized slices. */
export function chunkInvestors(
  investors: Address[],
  batchSize: number = SNAPSHOT_BATCH_SIZE,
): Address[][] {
  const out: Address[][] = []
  for (let i = 0; i < investors.length; i += batchSize) {
    out.push(investors.slice(i, i + batchSize))
  }
  return out
}

// ── In-flight detection (resume) ───────────────────────────────────────

/**
 * Read the current epoch for `token` and classify its state. Returns
 * `null` when there's no in-flight or completed epoch (or when no
 * snapshot proxy is configured for the token).
 *
 * Phase mapping table:
 *   - finalized=false, funded=false → 'snapshotting' (resume from
 *                                     epoch.holderCount)
 *   - finalized=true,  funded=false → 'finalizing'
 *                                     (the store maps this to the next
 *                                     actionable phase, which is
 *                                     'funding')
 *   - finalized=true,  funded=true  → 'done' (record-only; not in-flight)
 */
export async function detectInFlight(
  token: Address,
): Promise<InFlightSnapshot | null> {
  const snapshotAddr = snapshotProxyFor(token)
  if (!snapshotAddr) return null

  const ctx = buildReadContext()
  const client = new YieldSnapshotClient(ctx, snapshotAddr)

  const epochId = await client.getCurrentEpoch(token)
  if (epochId === 0n) return null

  const epoch = await client.getEpoch(epochId)

  const phase: InFlightSnapshot['phase'] = epoch.funded
    ? 'done'
    : epoch.finalized
      ? 'funding'
      : 'snapshotting'

  return {
    tokenAddress: token,
    snapshotAddress: snapshotAddr,
    epochId,
    epoch,
    phase,
  }
}

// ── Recent epochs (history strip) ──────────────────────────────────────

/**
 * Walk an epoch range in descending order, fetching `getEpoch(i)` for
 * each. Stops when `count` epochs have been collected or `i = 0` (epoch
 * 0 is unused per the SDK convention).
 *
 * Used by the "Recent Epochs" history strip below the wizard. Replaces
 * the legacy backend-indexed `loadDistributionHistory` with on-chain
 * reads — production-trajectory: the chain is the source of truth, not
 * a backend projection that lags by an indexer cycle.
 *
 * Filters epochs to the issuer's tokens by reading `epoch.token` per
 * entry — an issuer with TBILL1 + GOLD1 sees only their own token's
 * epochs even when both share a YieldSnapshot proxy.
 */
export async function loadRecentEpochs(
  issuerTokens: Address[],
  count: number = 10,
): Promise<Array<{
  snapshotAddress: Address
  epochId: bigint
  epoch: EpochView
}>> {
  if (issuerTokens.length === 0) return []

  const issuerTokenSet = new Set(issuerTokens.map(t => t.toLowerCase()))

  // Group by snapshot proxy — multiple tokens share one proxy on staging,
  // and walking each proxy once is cheaper than walking once per token.
  const byProxy = new Map<Address, Address[]>()
  for (const t of issuerTokens) {
    const proxy = snapshotProxyFor(t)
    if (!proxy) continue
    const list = byProxy.get(proxy) ?? []
    list.push(t)
    byProxy.set(proxy, list)
  }
  if (byProxy.size === 0) return []

  const ctx = buildReadContext()
  const collected: Array<{
    snapshotAddress: Address
    epochId: bigint
    epoch: EpochView
  }> = []

  for (const [proxy, tokensOnProxy] of byProxy) {
    const client = new YieldSnapshotClient(ctx, proxy)
    // Upper bound for the walk: max(currentEpoch[t]) across our tokens.
    // Cheaper than a single `nextEpochId()` when the proxy hosts tokens
    // we don't own.
    const ceilings = await Promise.all(
      tokensOnProxy.map(t => client.getCurrentEpoch(t)),
    )
    const maxEpoch = ceilings.reduce(
      (m, e) => (e > m ? e : m),
      0n,
    )
    if (maxEpoch === 0n) continue

    // Walk descending until we've collected `count` for this proxy or
    // exhausted the range. Per-proxy collection is fine — the final
    // descending sort merges results across proxies.
    let perProxy = 0
    for (let i = maxEpoch; i > 0n && perProxy < count; i--) {
      const epoch = await client.getEpoch(i)
      if (!issuerTokenSet.has(epoch.token.toLowerCase())) continue
      collected.push({ snapshotAddress: proxy, epochId: i, epoch })
      perProxy++
    }
  }

  // Most-recent first across all proxies, capped to `count`.
  collected.sort((a, b) => (b.epochId > a.epochId ? 1 : -1))
  return collected.slice(0, count)
}

export const SNAPSHOT_CONSTANTS = {
  BATCH_SIZE: SNAPSHOT_BATCH_SIZE,
  OPERATOR_EXPIRY_SECONDS,
} as const
