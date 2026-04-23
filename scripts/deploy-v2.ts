/**
 * scripts/deploy-v2.ts — Wave 3.5 deployment script skeleton
 *
 * Status: Phase 1 STUB. Implementations for `MuHavenSubscription`,
 * `MuHavenTreasury`, `RedemptionQueue`, `YieldSnapshot`, `TokenRegistry`,
 * `IdentityRegistry`, `ModularCompliance`, and the compliance modules land
 * in Phases 2–3 per `development/DEV_WAVE_3_5/WAVE_3_5_REVISED.md`.
 *
 * Usage (will be wired in Phase 8):
 *   pnpm run deploy:v2:local                      # in-process hardhat
 *   pnpm run deploy:v2:testnet                    # Arbitrum Sepolia (prod)
 *   pnpm run deploy:v2:testnet:stage              # Arbitrum Sepolia (stage)
 *
 * Output: `deployments/arb-sepolia-v2[.staging].json`
 *
 * Deployment order (per `CONTRACTS.md §14`):
 *   1. IdentityRegistry + ClaimTopicsRegistry + TrustedIssuersRegistry
 *   2. ModularCompliance (modules deployed + bound later per onboarding)
 *   3. TokenRegistry
 *   4. IssuerControlledOracle (one per token — deployed via onboard-token.ts)
 *   5. MuHavenToken (per-token — deployed via onboard-token.ts)
 *   6. MuHavenTreasury (per-token — deployed via onboard-token.ts)
 *   7. MuHavenSubscription (single platform instance)
 *   8. RedemptionQueue (per-token — deployed via onboard-token.ts)
 *   9. YieldSnapshot (single platform instance)
 *
 * NOTE: MuHavenVault (Wave 3) and ERC3643KYCAdapter (Wave 3) are NOT
 * redeployed — Wave 3.5 uses IdentityRegistry in their place for KYC. Vault
 * carries over unchanged.
 */

import { network } from "hardhat";

async function main() {
  const net = network.name;
  const envName = (process.env.MUHAVEN_ENV || "prod").toLowerCase();

  if (envName !== "prod" && envName !== "staging") {
    throw new Error(`MUHAVEN_ENV must be 'prod' or 'staging' (got '${envName}')`);
  }

  console.log(`\nMuHaven Wave 3.5 deploy target: [${net}] env=${envName}`);
  console.log("Phase 1 stub — full deployment wiring lands in Phase 8.\n");

  console.log("TODO steps (Phase 8):");
  console.log("  [ ] Deploy IdentityRegistry + ClaimTopicsRegistry + TrustedIssuersRegistry");
  console.log("  [ ] Deploy ModularCompliance");
  console.log("  [ ] Deploy TokenRegistry");
  console.log("  [ ] Deploy MuHavenSubscription (single)");
  console.log("  [ ] Deploy YieldSnapshot (single)");
  console.log("  [ ] Onboard per-token stack for TBILL1 (scripts/onboard-token.ts)");
  console.log("  [ ] Onboard per-token stack for GOLD1 (scripts/onboard-token.ts)");
  console.log("  [ ] Bulk-import Wave 3 whitelist into IdentityRegistry");
  console.log("  [ ] Verify every proxy on Arbiscan");
  console.log("  [ ] Persist deployments/arb-sepolia-v2[.staging].json");
  console.log("  [ ] Keep devMode = true with prominent banner (ADR-023)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
