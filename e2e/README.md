# MuHaven E2E — Playwright distribute click-through

Drives the live Arb Sepolia **DistributePage** flow against the deployed MuHaven frontend. Passkey prompts are OS-level so the user must confirm biometrics; everything else is automated.

## One-time setup

```bash
cd e2e
pnpm install
pnpm install:browsers    # downloads chromium binary for Playwright
```

## Run

```bash
# Default: runs against muhaven.hasto.dev
pnpm distribute

# Override base URL (e.g. against a dev deploy)
E2E_BASE_URL=https://staging.muhaven.hasto.dev pnpm distribute

# Override amount (default 0.5 PUSDC)
E2E_AMOUNT=1.0 pnpm distribute
```

## Flow (what the script does and when it pauses)

1. Launches Chromium with a **persistent profile** at `.playwright-profile/`. The profile keeps the passkey across runs — register once, subsequent runs reuse the passkey.
2. Navigates to `/login`.
3. **If the profile has no passkey yet:**
   - Switches to Register mode, fills "E2E Test Key" as passkey name.
   - Clicks Create Account → **you confirm the biometric prompt**.
   - After auth completes, the "Demo mode — self-serve KYC" banner appears. The script clicks **Enable demo access** → waits for the whitelist tx.
   - Once the TopNav pill shows an address, the script prints it and **pauses** — at this point you must run `E2E_ADDRESS=0x... pnpm run setup:e2e` in a separate terminal to grant the smart account issuer roles + wrap PUSDC. Press Enter in the script terminal to resume.
4. **If the profile already has a passkey:**
   - Clicks Sign In → **you confirm the biometric prompt**.
   - Proceeds directly to step 5.
5. Navigates to `/distribute`.
6. Picks the first available token from the token select, fills the amount.
7. Clicks Distribute → **you confirm ~5 biometric prompts** (one per UserOp: setOperator if needed, startDistribution, batchCreate, setEscrowIds, processBatch).
8. Waits for the stepper to reach the final step + receipt showing distribution ID.
9. Verifies on-chain via public RPC: reads `YieldDistributor.distributionCount()` and compares to the pre-test value.
10. Captures a screenshot + trace in `screenshots/` + `trace/`.

## When it fails

- **Bundler gas cap on batchCreate** → look at the UserOp hash in the console, paste into ZeroDev dashboard.
- **Passkey prompt doesn't appear** → the profile may be stale; delete `.playwright-profile/` and re-run.
- **Pre-flight check fails** → script surfaces the specific error ("PUSDC balance too low", "not authorized caller"). Re-run `setup:e2e` with the right flags.
- **Stepper hangs on "batchCreate"** → the N investors may be too many for a single UserOp callData — reduce `batchSize` in DistributePage (currently 50) or reduce investor count in setup-e2e.
