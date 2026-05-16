/**
 * scripts/authorize-yield-distributor-caller.ts
 *
 * Operator-only: add an issuer kernel to the `authorizedCallers` map of the
 * yield-distribution pipeline contracts so it can drive `distribute_yield`
 * via HavenBot. Authorizes both `YieldDistributor` AND `MuHavenEscrow` by
 * default because the SDK pipeline crosses both contracts (Phase 1:
 * `YieldDistributor.startDistribution`, Phase 2: `MuHavenEscrow.batchCreate`
 * + `YieldDistributor.setEscrowIds`, Phase 3: `YieldDistributor.processBatch`
 * which then calls `MuHavenEscrow.fundFrom` from YD's context).
 *
 * Surfaced 2026-05-21 Phase 2 prod walkthrough: the Wave-3 singletons gate
 * issuer-side writes on `owner || authorizedCallers[caller]`, and self-serve
 * issuer kernels from Phase 9.A onboarding were never added to either map.
 *
 * Interim operator unblock. Replaced post-walkthrough by a server-side
 * `IssuerYieldPipelineAuthService` (Design A analog) that auto-rotates the
 * issuer into both maps the first time HavenBot proposes a distribute_yield
 * for that kernel. No operator script after the hot-fix lands.
 *
 * Usage
 * ─────
 *   # Authorize on BOTH YD and MuHavenEscrow (default):
 *   MUHAVEN_ENV=prod \
 *   MUHAVEN_ISSUER_KERNEL=0x7E61a447527Cc93A20dC55adE3EFbDE6024980F1 \
 *   pnpm hardhat run scripts/authorize-yield-distributor-caller.ts --network arb-sepolia
 *
 *   # Only one target:
 *   MUHAVEN_TARGET=YieldDistributor   # or MuHavenEscrow
 *
 *   # Revoke instead of grant:
 *   MUHAVEN_REVOKE=1
 *
 * Required env
 *   MUHAVEN_ENV            prod | staging (no default).
 *   MUHAVEN_ISSUER_KERNEL  0x-prefixed kernel address to authorize.
 *
 * Optional env
 *   MUHAVEN_TARGET         YieldDistributor | MuHavenEscrow | both (default both).
 *   MUHAVEN_REVOKE         "1" / "true" to call setAuthorizedCaller(addr, false).
 *
 * Pre-flight: deployer PRIVATE_KEY in root .env must own the target contract(s).
 * Idempotent: skips the tx if the state already matches the requested value.
 */

import { ethers } from "hardhat";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

// YieldDistributor uses `owner()`; MuHavenEscrow uses `contractOwner()`. Both
// expose the same `authorizedCallers(address) view returns (bool)` map and
// the same `setAuthorizedCaller(address,bool)` setter.
const SHARED_ABI = [
  "function authorizedCallers(address) view returns (bool)",
  "function setAuthorizedCaller(address caller, bool authorized)",
];
const YD_OWNER_ABI = ["function owner() view returns (address)"];
const ESCROW_OWNER_ABI = ["function contractOwner() view returns (address)"];

type TargetName = "YieldDistributor" | "MuHavenEscrow";

interface TargetSpec {
  name: TargetName;
  address: string;
  ownerFn: "owner" | "contractOwner";
  ownerAbi: string[];
}

function deploymentPath(env: string): string {
  // Both YieldDistributor and MuHavenEscrow live in the Wave-3 deployment file.
  const suffix = env === "staging" ? ".staging" : "";
  return join(__dirname, "..", "deployments", `arb-sepolia${suffix}.json`);
}

async function processTarget(
  spec: TargetSpec,
  issuerAddr: string,
  desired: boolean,
  signerAddr: string,
): Promise<{ name: TargetName; status: "skipped" | "updated"; txHash?: string }> {
  console.log(`\n── ${spec.name} @ ${spec.address} ─────────────────────`);

  const c = new ethers.Contract(
    spec.address,
    [...SHARED_ABI, ...spec.ownerAbi],
    (await ethers.getSigners())[0],
  );

  const [owner, current] = await Promise.all([
    c[spec.ownerFn]() as Promise<string>,
    c.authorizedCallers(issuerAddr) as Promise<boolean>,
  ]);
  console.log(`  ${spec.ownerFn.padEnd(13)} : ${owner}`);
  console.log(`  current auth  : ${current}`);

  if (owner.toLowerCase() !== signerAddr.toLowerCase()) {
    throw new Error(
      `Signer is not the ${spec.name} ${spec.ownerFn} — setAuthorizedCaller will revert. ` +
        `Confirm PRIVATE_KEY in root .env is the deployer EOA.`,
    );
  }

  if (current === desired) {
    console.log(`  → Noop (already ${desired})`);
    return { name: spec.name, status: "skipped" };
  }

  console.log(`  → setAuthorizedCaller(${issuerAddr}, ${desired})`);
  const tx = await c.setAuthorizedCaller(issuerAddr, desired);
  console.log(`  tx hash       : ${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Tx failed (status=${receipt?.status}): ${tx.hash}`);
  }
  console.log(`  ✓ mined in block ${receipt.blockNumber}`);
  // Skip the post-write re-read — Arbitrum public RPC view-lag can return
  // stale state and confuse the operator. Receipt status is authoritative.
  return { name: spec.name, status: "updated", txHash: tx.hash };
}

async function main() {
  const rawEnv = process.env.MUHAVEN_ENV;
  if (!rawEnv || rawEnv.trim() === "") {
    throw new Error(
      `MUHAVEN_ENV is required (must be "prod" or "staging"). No default.`,
    );
  }
  const env = rawEnv.toLowerCase();
  if (env !== "prod" && env !== "staging") {
    throw new Error(`MUHAVEN_ENV must be "prod" or "staging", got "${rawEnv}"`);
  }

  const issuer = process.env.MUHAVEN_ISSUER_KERNEL;
  if (!issuer || !/^0x[a-fA-F0-9]{40}$/.test(issuer)) {
    throw new Error(
      `MUHAVEN_ISSUER_KERNEL is required and must be a 0x-prefixed 40-hex address`,
    );
  }
  const issuerAddr = ethers.getAddress(issuer);

  const revoke = ["1", "true", "yes"].includes(
    (process.env.MUHAVEN_REVOKE ?? "").toLowerCase(),
  );
  const desired = !revoke;

  const targetFilter = (process.env.MUHAVEN_TARGET ?? "both").toLowerCase();
  if (!["both", "yielddistributor", "muhavenescrow"].includes(targetFilter)) {
    throw new Error(
      `MUHAVEN_TARGET must be "YieldDistributor", "MuHavenEscrow", or "both" (default), got "${process.env.MUHAVEN_TARGET}"`,
    );
  }

  const path = deploymentPath(env);
  if (!existsSync(path)) throw new Error(`Deployment file not found: ${path}`);
  const deployment = JSON.parse(readFileSync(path, "utf-8"));
  const ydAddr: string | undefined = deployment?.contracts?.YieldDistributor?.proxy;
  const escrowAddr: string | undefined =
    deployment?.contracts?.MuHavenEscrow?.proxy ??
    deployment?.contracts?.MuHavenEscrow?.address;
  if (!ydAddr || ydAddr === ethers.ZeroAddress) {
    throw new Error(`YieldDistributor proxy not configured in ${path}`);
  }
  if (!escrowAddr || escrowAddr === ethers.ZeroAddress) {
    throw new Error(`MuHavenEscrow not configured in ${path}`);
  }

  const allTargets: TargetSpec[] = [
    {
      name: "YieldDistributor",
      address: ydAddr,
      ownerFn: "owner",
      ownerAbi: YD_OWNER_ABI,
    },
    {
      name: "MuHavenEscrow",
      address: escrowAddr,
      ownerFn: "contractOwner",
      ownerAbi: ESCROW_OWNER_ABI,
    },
  ];
  const targets = allTargets.filter((t) => {
    if (targetFilter === "both") return true;
    return t.name.toLowerCase() === targetFilter;
  });

  const [signer] = await ethers.getSigners();
  const signerAddr = await signer.getAddress();

  console.log(`Network          : ${env}`);
  console.log(`Issuer kernel    : ${issuerAddr}`);
  console.log(`Action           : ${desired ? "GRANT" : "REVOKE"}`);
  console.log(`Deployer signer  : ${signerAddr}`);
  console.log(`Targets          : ${targets.map((t) => t.name).join(", ")}`);

  const results: Array<{ name: TargetName; status: string; txHash?: string }> = [];
  for (const t of targets) {
    results.push(await processTarget(t, issuerAddr, desired, signerAddr));
  }

  console.log("\nSummary");
  for (const r of results) {
    console.log(
      `  ${r.name.padEnd(20)} ${r.status}${r.txHash ? ` (${r.txHash})` : ""}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
