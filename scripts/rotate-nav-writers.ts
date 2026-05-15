/**
 * scripts/rotate-nav-writers.ts — one-off rotation of `navWriter` on the
 * `IssuerControlledOracle` for one or more onboarded tokens.
 *
 * Use case (2026-05-17 Design A backfill): existing tokens were
 * onboarded with `navWriter = issuer` per the prior default. Now that
 * the default has flipped to platform-managed (the `NAV_PUBLISHER`
 * signer), pre-existing tokens need a one-time rotation so the
 * platform's `nav-publisher` service can keep them fresh.
 *
 * Signer requirement: the oracle owner (prod deployer = MuHaven
 * platform's privileged signer). `setNavWriter` is `onlyOwner`-gated.
 *
 * Modes:
 *   - Dry run (default): prints the rotation table — current writer,
 *     target writer, whether the change would actually happen. NO tx
 *     sent.
 *   - Execute: pass `--execute` (or set `EXECUTE=1`) to actually send
 *     `setNavWriter` for each token whose current writer ≠ target.
 *     Idempotent: tokens already at target are skipped.
 *
 * Usage:
 *   # Backfill: rotate every token in the prod deployment to a single
 *   # target writer.
 *   MUHAVEN_ENV=prod \
 *   NEW_NAV_WRITER=0x<platform-nav-publisher-eoa> \
 *   pnpm hardhat run scripts/rotate-nav-writers.ts --network arb-sepolia
 *
 *   # Then with --execute when the dry-run looks right:
 *   MUHAVEN_ENV=prod \
 *   NEW_NAV_WRITER=0x... \
 *   EXECUTE=1 \
 *   pnpm hardhat run scripts/rotate-nav-writers.ts --network arb-sepolia
 *
 *   # Subset rotation (only specific tokens):
 *   NAV_WRITER_ROTATE_TARGETS=0xtoken1,0xtoken2 \
 *   NEW_NAV_WRITER=0x... \
 *   EXECUTE=1 \
 *   pnpm hardhat run scripts/rotate-nav-writers.ts --network arb-sepolia
 *
 * Required env:
 *   MUHAVEN_ENV          prod | staging  (default: prod)
 *   NEW_NAV_WRITER       address EOA to set as the new navWriter
 *
 * Optional env:
 *   NAV_WRITER_ROTATE_TARGETS  comma-separated token addresses to
 *                              rotate. If unset, enumerates ALL active
 *                              tokens from `TokenRegistry`.
 *   EXECUTE                    1 = send txs; unset/0 = dry-run only
 */

import hre, { ethers, network } from "hardhat";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ORACLE_ABI = [
  "function getNavWriter(address token) view returns (address)",
  "function setNavWriter(address token, address newWriter) external",
  "function owner() view returns (address)",
];

const REGISTRY_ABI = [
  "function getRegisteredTokens(uint256 offset, uint256 limit) view returns (address[] memory)",
  "function registeredTokenCount() view returns (uint256)",
  "function isActive(address token) view returns (bool)",
  "function getConfig(address token) view returns (tuple(bool active, address treasury, address queue, address oracle, address issuer, uint128 minInvestment, uint128 instantRedeemCap, uint32 epochDuration, bool paused))",
];

function deploymentPath(env: string): string {
  const suffix = env === "staging" ? ".staging" : "";
  return join(__dirname, "..", "deployments", `arb-sepolia-v2${suffix}.json`);
}

function isHexAddress(value: string): value is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

async function enumerateActiveTokens(
  registry: any,
): Promise<{ address: string; oracle: string }[]> {
  const count: bigint = await registry.registeredTokenCount();
  const all: string[] = [];
  const pageSize = 100n;
  for (let off = 0n; off < count; off += pageSize) {
    const page: string[] = await registry.getRegisteredTokens(off, pageSize);
    all.push(...page);
  }
  // Filter: active = true (paused tokens still need fresh NAV so we don't
  // exclude them — pausing freezes purchases but the oracle should keep
  // moving until the operator decides to unpause).
  const result: { address: string; oracle: string }[] = [];
  for (const tokenAddr of all) {
    const cfg = await registry.getConfig(tokenAddr);
    if (!cfg.active) continue;
    result.push({ address: tokenAddr, oracle: cfg.oracle });
  }
  return result;
}

async function main() {
  const env = (process.env.MUHAVEN_ENV ?? "prod").toLowerCase();
  if (env !== "prod" && env !== "staging") {
    throw new Error(`MUHAVEN_ENV must be "prod" or "staging", got "${env}"`);
  }
  const newWriterRaw = process.env.NEW_NAV_WRITER;
  if (!newWriterRaw || !isHexAddress(newWriterRaw)) {
    throw new Error(
      `NEW_NAV_WRITER must be a 0x-prefixed 20-byte hex address. Got: ${newWriterRaw ?? "<unset>"}`,
    );
  }
  const newWriter = ethers.getAddress(newWriterRaw);
  const execute = process.env.EXECUTE === "1" || process.argv.includes("--execute");

  const path = deploymentPath(env);
  if (!existsSync(path)) {
    throw new Error(`Deployment file not found: ${path}`);
  }
  const deployment = JSON.parse(readFileSync(path, "utf-8"));

  // The deployment file pins the TokenRegistry + IssuerControlledOracle
  // proxies. All onboarded tokens share the same oracle proxy (per
  // `TokenConfig.oracle` field). Per-token oracle override is allowed
  // but in practice unused.
  const registryAddr = deployment.contracts?.TokenRegistry?.proxy;
  if (!registryAddr) {
    throw new Error(`TokenRegistry proxy not found in ${path}`);
  }
  const oracleAddr = deployment.contracts?.IssuerControlledOracle?.proxy;
  if (!oracleAddr) {
    throw new Error(`IssuerControlledOracle proxy not found in ${path}`);
  }

  const [signer] = await ethers.getSigners();
  const registry = new ethers.Contract(registryAddr, REGISTRY_ABI, signer);
  const oracle = new ethers.Contract(oracleAddr, ORACLE_ABI, signer);

  const owner: string = await oracle.owner();
  console.log(`Network          : ${network.name}`);
  console.log(`Env              : ${env}`);
  console.log(`Signer           : ${signer.address}`);
  console.log(`Oracle           : ${oracleAddr}`);
  console.log(`Oracle owner     : ${owner}`);
  console.log(`Target writer    : ${newWriter}`);
  console.log(`Mode             : ${execute ? "EXECUTE (live txs)" : "DRY-RUN"}`);

  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    console.error(
      `\n❌ Signer is not the oracle owner. \`setNavWriter\` is onlyOwner-gated.\n`,
    );
    console.error(`   Run with PRIVATE_KEY set to the owner's key.`);
    process.exit(1);
  }

  // Resolve target token set
  let targets: string[];
  const overrideRaw = process.env.NAV_WRITER_ROTATE_TARGETS;
  if (overrideRaw && overrideRaw.trim() !== "") {
    targets = overrideRaw
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .map((t) => {
        if (!isHexAddress(t)) {
          throw new Error(`NAV_WRITER_ROTATE_TARGETS contains malformed address: ${t}`);
        }
        return ethers.getAddress(t);
      });
    console.log(`\nTargets (from NAV_WRITER_ROTATE_TARGETS env): ${targets.length}`);
  } else {
    const enumerated = await enumerateActiveTokens(registry);
    targets = enumerated.map((t) => t.address);
    console.log(`\nTargets (enumerated from TokenRegistry, active=true): ${targets.length}`);
  }

  if (targets.length === 0) {
    console.log("No tokens to consider. Exiting.");
    return;
  }

  // Build the rotation plan
  type Row = {
    token: string;
    currentWriter: string;
    target: string;
    action: "rotate" | "skip-already-set";
  };
  const plan: Row[] = [];
  for (const token of targets) {
    const current: string = await oracle.getNavWriter(token);
    const action =
      current.toLowerCase() === newWriter.toLowerCase()
        ? "skip-already-set"
        : "rotate";
    plan.push({ token, currentWriter: current, target: newWriter, action });
  }

  console.log("\nRotation plan:");
  console.log("┌─────────────────────────────────────────────┬─────────────────────────────────────────────┬──────────────────┐");
  console.log("│ token                                       │ current writer                              │ action           │");
  console.log("├─────────────────────────────────────────────┼─────────────────────────────────────────────┼──────────────────┤");
  for (const row of plan) {
    console.log(
      `│ ${row.token.padEnd(43)} │ ${row.currentWriter.padEnd(43)} │ ${row.action.padEnd(16)} │`,
    );
  }
  console.log("└─────────────────────────────────────────────┴─────────────────────────────────────────────┴──────────────────┘");

  const toRotate = plan.filter((r) => r.action === "rotate");
  console.log(
    `\nWould rotate ${toRotate.length} of ${plan.length} tokens (${plan.length - toRotate.length} already at target).`,
  );

  if (!execute) {
    console.log("\n(Dry-run mode — no transactions sent. Re-run with EXECUTE=1 or --execute to apply.)");
    return;
  }

  if (toRotate.length === 0) {
    console.log("\nNo rotations needed — all tokens already at target writer.");
    return;
  }

  console.log("\nExecuting rotations…");
  for (const row of toRotate) {
    try {
      console.log(`\n[${row.token}] setNavWriter(${row.target})…`);
      const tx = await oracle.setNavWriter(row.token, row.target);
      console.log(`  tx: ${tx.hash}`);
      const rcpt = await tx.wait();
      console.log(`  ✓ confirmed in block ${rcpt?.blockNumber}`);
    } catch (err) {
      console.error(`  ✗ FAILED:`, err instanceof Error ? err.message : err);
      // Continue with other tokens — partial rotation is acceptable.
    }
  }

  console.log("\nDone. Verify with `scripts/refresh-oracle.ts` or the prod /health/nav endpoint.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
