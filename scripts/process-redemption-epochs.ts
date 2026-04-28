/**
 * Issuer-side: drive `RedemptionQueue.processEpoch` over every onboarded
 * token's pending epochs until no queued requests remain. Phase 7.6 atomic
 * settlement (per `MHUSD_AUDIT_PREP.md` §A-9) means the investor sees the
 * mhUSDC payout the moment this lands — no separate `claim` step is
 * required.
 *
 * For each token in `deployments/arb-sepolia-v2[.staging].json`:
 *   - Read `currentEpoch()` + scan epochs 0..currentEpoch-1.
 *   - For each epoch with a non-empty request list, call
 *     `processEpoch(epochId, 0, n)`. The function is idempotent over
 *     already-settled requests, so re-running is safe.
 *
 * Run with the issuer key set on the token's TokenRegistry config (on
 * staging that's the deployer). NAV must be `isFresh` for the oracle the
 * token is wired to — run `scripts/refresh-oracle.ts` first if needed.
 *
 * Usage:
 *   MUHAVEN_ENV=staging pnpm hardhat run scripts/process-redemption-epochs.ts --network arb-sepolia
 */

import { ethers, network } from "hardhat";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const QUEUE_ABI = [
  "function currentEpoch() view returns (uint256)",
  "function getEpochRequests(uint256 epochId) view returns (uint256[])",
  "function getRequest(uint256 requestId) view returns (tuple(address investor, bytes32 encShares, bytes32 encProceeds, uint256 epochId, address ephemeralEOA, uint128 maxSharesHint, bool settled, bool claimed, bool cancelled))",
  "function processEpoch(uint256 epochId, uint256 startIdx, uint256 endIdx) external",
  "function issuer() view returns (address)",
];

function deploymentPath(env: string): string {
  const suffix = env === "staging" ? ".staging" : "";
  return join(__dirname, "..", "deployments", `arb-sepolia-v2${suffix}.json`);
}

async function main() {
  const env = (process.env.MUHAVEN_ENV ?? "prod").toLowerCase();
  if (env !== "prod" && env !== "staging") {
    throw new Error(`MUHAVEN_ENV must be "prod" or "staging", got "${env}"`);
  }
  const path = deploymentPath(env);
  if (!existsSync(path)) throw new Error(`Deployment file not found: ${path}`);
  const deployment = JSON.parse(readFileSync(path, "utf-8"));
  const tokens = deployment.tokens ?? {};

  const [signer] = await ethers.getSigners();
  console.log(`Network : ${network.name}`);
  console.log(`Env     : ${env}`);
  console.log(`Signer  : ${signer.address}\n`);

  for (const [symbol, info] of Object.entries(tokens) as [string, any][]) {
    const queueAddr: string | undefined = info?.contracts?.RedemptionQueue?.proxy;
    if (!queueAddr) {
      console.log(`[${symbol}] no RedemptionQueue — skipping`);
      continue;
    }

    const queue = new ethers.Contract(queueAddr, QUEUE_ABI, signer);
    const issuer: string = await queue.issuer();
    if (issuer.toLowerCase() !== signer.address.toLowerCase()) {
      console.log(
        `[${symbol}] issuer is ${issuer}, signer is ${signer.address} — skipping`,
      );
      continue;
    }

    const current: bigint = await queue.currentEpoch();
    console.log(`[${symbol}] currentEpoch = ${current.toString()}`);

    // Epochs are time-sliced via `block.timestamp / epochDuration`, so for a
    // 1-day epochDuration `currentEpoch` is the day count since unix epoch
    // (~20571 today). Iterating from 0 hits 20k+ no-op RPC calls. Scan a
    // bounded recent window instead. 30 days back is generous for staging
    // smoke tests; bump if a legitimate test sits longer than this.
    //
    // Includes the *current* epoch — the contract permits processing the
    // open epoch too, which is what we need for a same-day smoke test
    // (investor sells now, issuer processes immediately after, no need to
    // wait for the epoch to close).
    const lookbackEpochs = 30n;
    const startEpoch = current > lookbackEpochs ? current - lookbackEpochs : 0n;

    let processedAny = false;
    for (let epoch = startEpoch; epoch <= current; epoch++) {
      const ids: bigint[] = await queue.getEpochRequests(epoch);
      if (ids.length === 0) continue;

      // Skip if every request is already terminal (settled or cancelled).
      // Saves gas re-running over fully-processed epochs.
      let pending = 0;
      for (const rid of ids) {
        const r = await queue.getRequest(rid);
        if (!r.settled && !r.cancelled) pending++;
      }
      if (pending === 0) {
        console.log(
          `[${symbol}] epoch ${epoch.toString()}: ${ids.length} request(s), all terminal — skipping`,
        );
        continue;
      }

      console.log(
        `[${symbol}] epoch ${epoch.toString()}: ${ids.length} request(s), ${pending} pending — processing`,
      );
      const tx = await queue.processEpoch(epoch, 0, ids.length);
      console.log(`[${symbol}] processEpoch tx: ${tx.hash}`);
      await tx.wait();
      processedAny = true;
    }

    if (!processedAny) {
      console.log(`[${symbol}] no pending epochs to process`);
    }
    console.log("");
  }

  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
