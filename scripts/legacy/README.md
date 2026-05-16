# scripts/legacy/

Tombstoned operator scripts. Each file's top-of-file JSDoc carries the full
context for why it was retired and when. None of these are part of the live
HavenBot pipeline post-rewire (2026-05-22 — Wave 4 P7 Phase 2 swap from
Wave-3 `MuHavenClient.distributeYield` to Wave-3.5 `YieldSnapshot`; see
`development/DEV_WAVE_4/PHASE_2_YIELD_SNAPSHOT_REWIRE.md`).

## Files

- **`legacy-authorize-yield-distributor-caller.ts`** — Wave-3
  `YieldDistributor` + `MuHavenEscrow` `authorizedCallers` map maintenance.
  Run on prod 2026-05-21 as REMEDIATION for `0x7E61…80F1`. The new
  YieldSnapshot pipeline gates writes via `_issuerOf(token)` from
  `TokenRegistry.getConfig` — there is no `authorizedCallers` map.

- **`legacy-rotate-yield-distributor-pusdc.ts`** — One-shot Wave 3.5
  cutover for `YieldDistributor.pusdc`'s legacy → mhUSDC rotation. Run on
  prod 2026-05-21. YieldSnapshot's `pusdc` was rotated at the Phase 7.5
  cutover already.

## When to run anything in here

You shouldn't, in normal ops. These exist as forensics + rollback tooling
for the legacy Wave-3 yield-distribution pipeline (`YieldDistributor` +
`MuHavenEscrow`), which remains deployed on Arb Sepolia for historical
tests and ops fallback but is not on the live HavenBot path.

If you're considering running one, check first whether the live pipeline
(`YieldSnapshot` + `MuHavenStable`) is actually the surface that needs
maintenance — the answer is almost always yes.
