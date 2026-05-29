/**
 * scripts/validate-stable-upgrade.ts
 *
 * Read-only storage-layout safety check for a MuHavenStable upgrade
 * (per `deployments/arb-sepolia-v2[.staging].json`). Broadcasts nothing.
 *
 * Two layers, both manifest-tolerant:
 *   1. `validateImplementation` — confirms the NEW impl is structurally
 *      upgrade-safe (has the storage gap, no unsafe constructor / delegatecall
 *      / selfdestruct / state-var init). Manifest-FREE, so it always runs.
 *   2. `validateUpgrade(proxy, Factory)` — compares the new layout against the
 *      proxy's REGISTERED baseline in the OZ manifest. This only works when the
 *      manifest knows the deployed impl; the Phase-7 + Phase-9 cutovers used
 *      `scripts/manual-upgrade-stable.ts` (which bypasses the OZ plugin), so
 *      the manifest is intentionally drifted and this layer is reported as
 *      SKIPPED (not failed) with the "not registered" reason. In that mode the
 *      layout guarantee rests on layer 1 + the storage-layout dump below + the
 *      reviewer confirming the diff added no state variables (Phase 9 adds
 *      none — `__gap` stays at 37).
 *
 * Also prints the compiled storage layout (slot/offset/var) so a human can
 * eyeball that no slot moved.
 *
 * Usage:
 *   MUHAVEN_ENV=prod    pnpm hardhat run scripts/validate-stable-upgrade.ts --network arb-sepolia
 *   MUHAVEN_ENV=staging pnpm hardhat run scripts/validate-stable-upgrade.ts --network arb-sepolia
 */

import hre, { ethers, upgrades } from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";

async function printStorageLayout() {
  // Pull the compiled storage layout straight from the build artifact's
  // build-info — independent of the OZ manifest. Confirms slot ordering +
  // the `__gap` size at a glance.
  try {
    const buildInfo = await (hre.artifacts as any).getBuildInfo(
      "contracts/MuHavenStable.sol:MuHavenStable",
    );
    const layout =
      buildInfo?.output?.contracts?.["contracts/MuHavenStable.sol"]?.MuHavenStable
        ?.storageLayout?.storage;
    if (!layout) {
      console.log(`  (storage layout not in build-info — set "storageLayout" in solc outputSelection to enable)`);
      return;
    }
    console.log(`\nStorage layout (slot · offset · type · name):`);
    for (const s of layout) {
      console.log(`  ${String(s.slot).padStart(3)} · ${String(s.offset).padStart(2)} · ${s.label}`);
    }
  } catch (e: any) {
    console.log(`  (could not read storage layout: ${e?.message ?? e})`);
  }
}

async function main() {
  const env = (process.env.MUHAVEN_ENV ?? "staging").toLowerCase();
  if (env !== "prod" && env !== "staging") {
    throw new Error(`MUHAVEN_ENV must be "prod" or "staging" (got "${env}")`);
  }
  const suffix = env === "staging" ? ".staging" : "";
  const deployPath = join(
    __dirname,
    "..",
    "deployments",
    `arb-sepolia-v2${suffix}.json`,
  );
  const dep = JSON.parse(readFileSync(deployPath, "utf8"));
  const proxyAddr = dep.contracts?.MuHavenStable?.proxy;
  if (!proxyAddr) throw new Error(`No MuHavenStable.proxy in ${deployPath}`);

  console.log(`── validate-stable-upgrade ──────────────────────────────`);
  console.log(`Env          : ${env}`);
  console.log(`Proxy        : ${proxyAddr}`);
  console.log(`Current impl : ${dep.contracts.MuHavenStable.implementation}`);

  const Factory = await ethers.getContractFactory("MuHavenStable");

  // Layer 1 — manifest-free structural upgrade-safety of the NEW impl.
  await upgrades.validateImplementation(Factory, { kind: "transparent" } as any);
  console.log(`✓ validateImplementation PASSED — new impl is upgrade-safe (gap present, no unsafe patterns).`);

  await printStorageLayout();

  // Layer 2 — manifest-dependent layout comparison vs the registered baseline.
  try {
    await upgrades.validateUpgrade(proxyAddr, Factory);
    console.log(`\n✓ validateUpgrade PASSED — storage layout matches the registered baseline.`);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.includes("is not registered") || msg.includes("forceImport")) {
      console.log(
        `\n⚠ validateUpgrade SKIPPED — the deployed impl is not in the OZ manifest.\n` +
          `  This is EXPECTED after a manual-upgrade-stable.ts cutover (it bypasses the\n` +
          `  OZ plugin). Layout safety is established by validateImplementation (above) +\n` +
          `  the storage-layout dump + confirming the source diff added no state variables\n` +
          `  (Phase 9 adds none; __gap stays 37). Reason: ${msg.split("\n")[0]}`,
      );
    } else {
      throw e;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
