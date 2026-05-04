/**
 * Upper bound for array inputs to `MuHavenEscrow.batchCreate` and
 * `MuHavenEscrow.redeemMultiple`. Mirrors the on-chain `MAX_BATCH_SIZE`
 * constant — update both together if the contract constant changes
 * (see `POST_HACKATHON.md` for the tuning discussion).
 */
export const MAX_BATCH_SIZE = 200

/**
 * Default per-batch size for `createYieldEscrows` and the `processBatch`
 * loop inside `fundEscrows`. Chosen to stay comfortably under the gas
 * ceiling for FHE operations on Arbitrum Sepolia.
 */
export const DEFAULT_BATCH_SIZE = 50

/**
 * Phase 9.C / L1 (2026-05-04) — fixed-point scale applied to
 * `YieldSnapshot.Epoch.ratePerShare`. The cleartext rate the issuer
 * persists is `realRate × RATE_SCALE`; `claimYield` divides by this
 * constant after the per-share mul to recover unscaled mhUSDC base
 * units.
 *
 * Mirrors the on-chain `YieldSnapshot.RATE_SCALE` constant — keep the
 * two in lockstep when changing.
 *
 * Sub-1:1-yield example (4% APY on 25 MUSTB at $1 NAV → $1 yield):
 *   - amountUnits = 1_000_000 ($1 in mhUSDC base units)
 *   - totalSupplyUnits = 25_000_000 (25 MUSTB at 6-decimal scale)
 *   - ratePerShare = floor(1_000_000n × RATE_SCALE / 25_000_000n)
 *                  = floor(1_000_000_000_000n / 25_000_000n)
 *                  = 40_000n
 *   - per-investor share with 5 MUSTB balance = floor(5_000_000n ×
 *       40_000n / RATE_SCALE) = floor(200_000_000_000n / 1_000_000n) =
 *       200_000n = $0.20 in mhUSDC base units.
 */
export const RATE_SCALE = 1_000_000n
