/**
 * Issuer-side yield epoch runbook (Wave 3.5). Drives the full
 * YieldSnapshot lifecycle for a single token in one shot:
 *
 *   1. openEpoch(token)            — issuer
 *   2. snapshotBatch(epochId, [investors]) — paginated, issuer
 *   3. finalizeSnapshot(epochId)   — issuer
 *   4. fundEpoch(epochId, encTotalYield) — issuer pulls PUSDC via cofhe
 *
 * After step 4, every investor in the snapshot can call
 * `YieldSnapshot.claimYield(epochId, ephemeralEOA)` from the dashboard
 * (in scope of SESSION_PERMISSIONS, signs silently with session key).
 *
 * Pre-flight you must own:
 *   - PUSDC balance ≥ totalYield on the issuer wallet.
 *   - PUSDC operator approval: `legacyPusdc.setOperator(yieldSnapshot, expiry)`.
 *     The script checks + grants if missing.
 *
 * Args via env:
 *   MUHAVEN_ENV          prod | staging
 *   MUHAVEN_TOKEN_SYMBOL TBILL1 | GOLD1 (must match a token in the deployment file)
 *   MUHAVEN_TOTAL_YIELD  uint128 amount of PUSDC base units (6-decimal)
 *                          e.g. "1000000000" = 1000 PUSDC
 *
 * Usage:
 *   MUHAVEN_ENV=staging \
 *   MUHAVEN_TOKEN_SYMBOL=TBILL1 \
 *   MUHAVEN_TOTAL_YIELD=1000000000 \
 *   pnpm hardhat run scripts/run-yield-epoch.ts --network arb-sepolia
 */

import { ethers, network } from "hardhat";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { createCofheClient } from "../tasks/utils";
import { Encryptable } from "@cofhe/sdk";
import hre from "hardhat";

const SNAPSHOT_BATCH_SIZE = 50; // contract loops are ~200-investor budget; 50 is safe per tx.

const SNAPSHOT_ABI = [
  "function openEpoch(address token) returns (uint256)",
  "function snapshotBatch(uint256 epochId, address[] investors)",
  "function finalizeSnapshot(uint256 epochId)",
  "function fundEpoch(uint256 epochId, (uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature) encTotalYield)",
  "function currentEpoch(address token) view returns (uint256)",
  "function getEpoch(uint256 epochId) view returns (tuple(address token, bool finalized, bool funded, uint256 holderCount, uint256 snapshotStartTs, uint256 snapshotEndTs, bytes32 encTotalSupply, bytes32 encTotalYield, bytes32 encRatio, bytes32 encRemaining))",
];

const REGISTRY_ABI = [
  "function getHoldersPaginated(address token, uint256 offset, uint256 limit) view returns (address[])",
  "function holderCount(address token) view returns (uint256)",
];

const PUSDC_ABI = [
  "function isOperator(address holder, address spender) view returns (bool)",
  "function setOperator(address spender, uint48 until) external",
];

function deploymentPath(env: string): string {
  const suffix = env === "staging" ? ".staging" : "";
  return join(__dirname, "..", "deployments", `arb-sepolia-v2${suffix}.json`);
}

function envOrDie(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var required`);
  return v;
}

async function main() {
  const env = (process.env.MUHAVEN_ENV ?? "prod").toLowerCase();
  if (env !== "prod" && env !== "staging") {
    throw new Error(`MUHAVEN_ENV must be "prod" or "staging", got "${env}"`);
  }
  const symbol = envOrDie("MUHAVEN_TOKEN_SYMBOL");
  const totalYield = BigInt(envOrDie("MUHAVEN_TOTAL_YIELD"));
  if (totalYield <= 0n) throw new Error("MUHAVEN_TOTAL_YIELD must be > 0");

  const path = deploymentPath(env);
  if (!existsSync(path)) throw new Error(`Deployment file not found: ${path}`);
  const deployment = JSON.parse(readFileSync(path, "utf-8"));
  const tokens = deployment.tokens ?? {};
  const info = tokens[symbol];
  if (!info) throw new Error(`Token "${symbol}" not in deployment file`);

  const tokenAddr: string = info.contracts.MuHavenToken.proxy;
  const snapshotAddr: string = deployment.contracts.YieldSnapshot.proxy;
  const investorRegistryAddr: string = deployment.contracts.InvestorRegistry.proxy;
  const pusdcAddr: string = deployment.external?.legacyPusdc;
  if (!pusdcAddr) throw new Error("external.legacyPusdc missing in deployment");

  const [signer] = await ethers.getSigners();
  console.log(`Network    : ${network.name}`);
  console.log(`Env        : ${env}`);
  console.log(`Token      : ${symbol} (${tokenAddr})`);
  console.log(`Snapshot   : ${snapshotAddr}`);
  console.log(`TotalYield : ${totalYield.toString()} (PUSDC base units)`);
  console.log(`Signer     : ${signer.address}\n`);

  const snapshot = new ethers.Contract(snapshotAddr, SNAPSHOT_ABI, signer);
  const registry = new ethers.Contract(investorRegistryAddr, REGISTRY_ABI, signer);
  const pusdc = new ethers.Contract(pusdcAddr, PUSDC_ABI, signer);

  // ── 1. Pre-flight: PUSDC operator approval ─────────────────────────
  const isOp: boolean = await pusdc.isOperator(signer.address, snapshotAddr);
  if (!isOp) {
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60);
    console.log(`[pre] granting PUSDC operator → YieldSnapshot, until ${expiry}`);
    const tx = await pusdc.setOperator(snapshotAddr, expiry);
    console.log(`[pre] setOperator tx: ${tx.hash}`);
    await tx.wait();
  } else {
    console.log("[pre] PUSDC operator on YieldSnapshot already granted");
  }

  // ── 2. openEpoch ───────────────────────────────────────────────────
  let openTx = await snapshot.openEpoch(tokenAddr);
  console.log(`[1/4] openEpoch tx: ${openTx.hash}`);
  const rcpt = await openTx.wait();
  // Decode `EpochOpened(token, epochId)` from receipt logs.
  const iface = new ethers.Interface([
    "event EpochOpened(address indexed token, uint256 indexed epochId)",
  ]);
  let epochId: bigint | null = null;
  for (const log of rcpt!.logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "EpochOpened") {
        epochId = parsed.args.epochId as bigint;
        break;
      }
    } catch {
      /* ignore non-matching logs */
    }
  }
  if (epochId == null) throw new Error("openEpoch did not emit EpochOpened");
  console.log(`[1/4] epochId = ${epochId.toString()}\n`);

  // ── 3. snapshotBatch (paginated over InvestorRegistry holders) ─────
  const holderCount: bigint = await registry.holderCount(tokenAddr);
  console.log(`[2/4] holderCount(${symbol}) = ${holderCount.toString()}`);
  if (holderCount === 0n) {
    throw new Error("No holders to snapshot — investors must hold the token before opening an epoch");
  }

  let captured = 0n;
  for (let offset = 0n; offset < holderCount; offset += BigInt(SNAPSHOT_BATCH_SIZE)) {
    const limit = BigInt(SNAPSHOT_BATCH_SIZE);
    const investors: string[] = await registry.getHoldersPaginated(
      tokenAddr,
      offset,
      limit,
    );
    if (investors.length === 0) break;
    console.log(`[2/4] snapshotBatch offset=${offset.toString()} count=${investors.length}`);
    const tx = await snapshot.snapshotBatch(epochId, investors);
    console.log(`[2/4]   tx: ${tx.hash}`);
    await tx.wait();
    captured += BigInt(investors.length);
  }
  console.log(`[2/4] snapshotted ${captured.toString()} investors\n`);

  // ── 4. finalizeSnapshot ────────────────────────────────────────────
  console.log(`[3/4] finalizeSnapshot`);
  const finTx = await snapshot.finalizeSnapshot(epochId);
  console.log(`[3/4]   tx: ${finTx.hash}`);
  await finTx.wait();
  console.log("");

  // ── 5. fundEpoch (encrypts client-side via cofhe Node SDK) ─────────
  console.log(`[4/4] encrypting totalYield + calling fundEpoch`);
  const cofheClient = await createCofheClient(hre, signer as any);
  const [enc] = await cofheClient
    .encryptInputs([Encryptable.uint128(totalYield)])
    .setAccount(signer.address)
    .execute();

  const fundTx = await snapshot.fundEpoch(epochId, {
    ctHash: enc.ctHash,
    securityZone: enc.securityZone,
    utype: enc.utype,
    signature: enc.signature,
  });
  console.log(`[4/4]   tx: ${fundTx.hash}`);
  await fundTx.wait();
  console.log("");

  console.log(`Done. Investors can now call YieldSnapshot.claimYield(${epochId.toString()}, ephEOA)`);
  console.log(`from the dashboard — that path is in SESSION_PERMISSIONS so it signs silently.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
