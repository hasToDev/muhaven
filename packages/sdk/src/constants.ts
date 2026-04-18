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
