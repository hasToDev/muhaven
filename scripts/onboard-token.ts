/**
 * scripts/onboard-token.ts — Wave 3.5 per-token onboarding script skeleton
 *
 * Status: Phase 1 STUB. Implementation lands in Phase 8 per
 * `development/DEV_WAVE_3_5/WAVE_3_5_REVISED.md`.
 *
 * Purpose: deploy one RWA token's full stack and register it in the
 * platform. Designed to be re-runnable per token (TBILL1, GOLD1, ...).
 *
 * Usage (will be wired in Phase 8):
 *   MUHAVEN_TOKEN_SYMBOL=TBILL1 pnpm run onboard-token:testnet
 *   MUHAVEN_TOKEN_SYMBOL=GOLD1 pnpm run onboard-token:testnet
 *
 * Inputs (env vars consumed by the full impl):
 *   MUHAVEN_TOKEN_SYMBOL       — e.g. "TBILL1"
 *   MUHAVEN_TOKEN_NAME         — e.g. "MuHaven Treasury Bill Series 1"
 *   MUHAVEN_ISSUER             — issuer EOA address
 *   MUHAVEN_ORACLE_KIND        — "issuer" | "chainlink-functions"
 *   MUHAVEN_NAV_INITIAL        — initial NAV to publish (PUSDC base units per share)
 *   MUHAVEN_TREASURY_MIN_FLOAT — cleartext minFloat
 *   MUHAVEN_EPOCH_DURATION     — seconds per instant-redeem epoch
 *   MUHAVEN_INSTANT_CAP        — per-epoch instant-redeem PUSDC cap
 *   MUHAVEN_MIN_INVESTMENT     — cleartext lower-bound on maxSharesHint (ADR-025)
 *
 * Deployment steps (TODO in Phase 8):
 *   1. Deploy per-token IssuerControlledOracle (or ChainlinkFunctionsOracle)
 *   2. Deploy per-token MuHavenToken (behind Transparent Proxy)
 *   3. Deploy per-token MuHavenTreasury (bound to Token + Subscription + Queue)
 *   4. Deploy per-token RedemptionQueue (bound to Token + Treasury + issuer)
 *   5. Grant SUBSCRIPTION_ROLE on Token → platform MuHavenSubscription
 *   6. Register token in TokenRegistry with the config block
 *   7. Publish initial NAV
 *   8. Seed Treasury with initial PUSDC float (e.g. 10k PUSDC)
 *   9. Append address record to deployments/arb-sepolia-v2[.staging].json
 *  10. Verify every new proxy on Arbiscan
 */

import { network } from "hardhat";

async function main() {
  const net = network.name;
  const symbol = process.env.MUHAVEN_TOKEN_SYMBOL || "TBILL1";
  const envName = (process.env.MUHAVEN_ENV || "prod").toLowerCase();

  if (envName !== "prod" && envName !== "staging") {
    throw new Error(`MUHAVEN_ENV must be 'prod' or 'staging' (got '${envName}')`);
  }

  console.log(`\nOnboard RWA token ${symbol} to network=[${net}] env=${envName}`);
  console.log("Phase 1 stub — full onboarding lands in Phase 8.\n");

  console.log("Planned env inputs (Phase 8):");
  console.log("  MUHAVEN_TOKEN_SYMBOL        =", symbol);
  console.log("  MUHAVEN_TOKEN_NAME          =", process.env.MUHAVEN_TOKEN_NAME ?? "(unset)");
  console.log("  MUHAVEN_ISSUER              =", process.env.MUHAVEN_ISSUER ?? "(unset)");
  console.log("  MUHAVEN_ORACLE_KIND         =", process.env.MUHAVEN_ORACLE_KIND ?? "(unset)");
  console.log("  MUHAVEN_NAV_INITIAL         =", process.env.MUHAVEN_NAV_INITIAL ?? "(unset)");
  console.log("  MUHAVEN_TREASURY_MIN_FLOAT  =", process.env.MUHAVEN_TREASURY_MIN_FLOAT ?? "(unset)");
  console.log("  MUHAVEN_EPOCH_DURATION      =", process.env.MUHAVEN_EPOCH_DURATION ?? "(unset)");
  console.log("  MUHAVEN_INSTANT_CAP         =", process.env.MUHAVEN_INSTANT_CAP ?? "(unset)");
  console.log("  MUHAVEN_MIN_INVESTMENT      =", process.env.MUHAVEN_MIN_INVESTMENT ?? "(unset)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
