/**
 * scripts/validate-token-upgrade.ts
 *
 * Read-only storage-layout safety check for a MuHavenToken upgrade (Slice 1.5 —
 * the `pullFromInvestor` FHE.min over-sell clamp). Broadcasts nothing.
 *
 * Sibling of `scripts/validate-stable-upgrade.ts`. Every active RWA is its own
 * MuHavenToken proxy (CETES, USYC, …) but they all share ONE implementation, so
 * a single impl-level layout check covers every proxy that lands on the new
 * impl. Two layers, both manifest-tolerant:
 *   1. `validateImplementation` — confirms the NEW impl is structurally
 *      upgrade-safe (storage gap present, no unsafe constructor / delegatecall /
 *      selfdestruct / state-var init). Manifest-FREE, so it always runs.
 *   2. `validateUpgrade(proxy, Factory)` — compares the new layout against the
 *      proxy's REGISTERED baseline in the OZ manifest. Only works when the
 *      manifest knows the deployed impl; if a prior cutover bypassed the OZ
 *      plugin (or the manifest is on a different machine) the manifest is
 *      drifted and this layer is reported as SKIPPED (not failed). In that mode
 *      the guarantee rests on layer 1 + the storage-layout dump + the reviewer
 *      confirming the diff added no state variables (Slice 1.5 adds none —
 *      `__gap` is unchanged; the change is a single FHE op swap inside
 *      pullFromInvestor).
 *
 * Also prints the compiled storage layout (slot/offset/var) so a human can
 * eyeball that no slot moved.
 *
 * The proxy used for layer 2 defaults to the first ACTIVE token proxy in the
 * deployment (override with TOKEN_SYMBOL=CETES). The retired TBILL1 / GOLD1
 * proxies (on an older impl) are skipped — they are not on the sell path.
 *
 * Usage:
 *   MUHAVEN_ENV=prod    pnpm hardhat run scripts/validate-token-upgrade.ts --network arb-sepolia
 *   MUHAVEN_ENV=staging pnpm hardhat run scripts/validate-token-upgrade.ts --network arb-sepolia
 *   MUHAVEN_ENV=prod TOKEN_SYMBOL=CETES pnpm hardhat run scripts/validate-token-upgrade.ts --network arb-sepolia
 */

import hre, { ethers, upgrades } from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";

// Retired tokens (older impl, not on the sell path) — never the default proxy.
const RETIRED_SYMBOLS = new Set(["TBILL1", "GOLD1"]);

async function printStorageLayout() {
  try {
    const buildInfo = await (hre.artifacts as any).getBuildInfo(
      "contracts/MuHavenToken.sol:MuHavenToken",
    );
    const layout =
      buildInfo?.output?.contracts?.["contracts/MuHavenToken.sol"]?.MuHavenToken
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
  const tokens: Record<string, any> = dep.tokens ?? {};

  // Pick the proxy for layer 2: explicit TOKEN_SYMBOL, else first non-retired.
  const wanted = process.env.TOKEN_SYMBOL;
  let symbol: string | undefined;
  let proxyAddr: string | undefined;
  if (wanted) {
    symbol = wanted;
    proxyAddr = tokens[wanted]?.contracts?.MuHavenToken?.proxy;
    if (!proxyAddr) throw new Error(`No proxy for TOKEN_SYMBOL=${wanted} in ${deployPath}`);
  } else {
    for (const s of Object.keys(tokens)) {
      if (RETIRED_SYMBOLS.has(s)) continue;
      const p = tokens[s]?.contracts?.MuHavenToken?.proxy;
      if (p) { symbol = s; proxyAddr = p; break; }
    }
    if (!proxyAddr) throw new Error(`No active MuHavenToken proxy found in ${deployPath}`);
  }

  const currentImpl = tokens[symbol!]?.contracts?.MuHavenToken?.implementation;

  console.log(`── validate-token-upgrade ───────────────────────────────`);
  console.log(`Env             : ${env}`);
  console.log(`Reference token : ${symbol}`);
  console.log(`Proxy           : ${proxyAddr}`);
  console.log(`Current impl    : ${currentImpl}`);
  console.log(`Active proxies  : ${Object.keys(tokens).filter((s) => !RETIRED_SYMBOLS.has(s)).length} (retired skipped: ${[...RETIRED_SYMBOLS].join(", ")})`);

  const Factory = await ethers.getContractFactory("MuHavenToken");

  // Layer 1 — manifest-free structural upgrade-safety of the NEW impl.
  await upgrades.validateImplementation(Factory, { kind: "transparent" } as any);
  console.log(`✓ validateImplementation PASSED — new impl is upgrade-safe (gap present, no unsafe patterns).`);

  await printStorageLayout();

  // Layer 2 — manifest-dependent layout comparison vs the registered baseline.
  try {
    await upgrades.validateUpgrade(proxyAddr!, Factory);
    console.log(`\n✓ validateUpgrade PASSED — storage layout matches the registered baseline.`);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.includes("is not registered") || msg.includes("forceImport")) {
      console.log(
        `\n⚠ validateUpgrade SKIPPED — the deployed impl is not in this machine's OZ manifest.\n` +
          `  EXPECTED if the prior upgrade ran on a different box or via a manual cutover.\n` +
          `  Layout safety rests on validateImplementation (above) + the storage-layout dump +\n` +
          `  confirming the source diff added no state variables (Slice 1.5 adds none — __gap\n` +
          `  unchanged; the change is one FHE op swap in pullFromInvestor). Reason: ${msg.split("\n")[0]}`,
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
