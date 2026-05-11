/**
 * scripts/unpause-token.ts
 *
 * Operator-only: complete the post-deploy "wizard step 6" for one or
 * more freshly-deployed RWA tokens — set the initial NAV on the
 * IssuerControlledOracle and flip `TokenRegistry.paused = false`.
 *
 * Why this exists
 * ───────────────
 * The F2 self-serve issuer onboarding wizard (`/apply-issuer`) registers
 * each new token PAUSED on-chain because the registered NAV writer is
 * the **applicant kernel**, not the platform deployer — so the deploy
 * library can't push the initial NAV mid-deploy. Step 6 of the wizard
 * was specced to prompt the kernel for two follow-up txs
 * (`oracle.setNAV(token, initial)` + `tokenRegistry.setPaused(token, false)`)
 * but kernel-prompted UserOps for those calls were deferred per the F2
 * shipping notes — see PHASE_9A_EXPANSION_PLAN.md §F2 deviations.
 *
 * Until kernel-driven step 6 lands, this script is the operator helper
 * that closes the loop. The deployer EOA (TokenRegistry owner) can BOTH
 * write NAV via `setNavWriter(token, deployer)` rotation OR temporarily
 * via the existing nav-writer assignment if the wizard set it that way
 * — this script handles the simpler path: deployer rotates itself in as
 * NAV writer for the duration of the call, writes initial NAV, then
 * rotates back to the applicant kernel and unpauses. Net result: token
 * is active, applicant kernel retains NAV writer rights post-script.
 *
 * Usage
 * ─────
 *   # Staging (reads deployments/arb-sepolia-v2.staging.json):
 *   MUHAVEN_ENV=staging \
 *   MUHAVEN_TOKEN_SYMBOL=TBILL2 \
 *   MUHAVEN_INITIAL_NAV=1000000 \
 *   pnpm hardhat run scripts/unpause-token.ts --network arb-sepolia
 *
 *   # Production (reads deployments/arb-sepolia-v2.json):
 *   MUHAVEN_ENV=prod \
 *   MUHAVEN_TOKEN_SYMBOL=TBILL1 \
 *   MUHAVEN_INITIAL_NAV=1000000 \
 *   pnpm hardhat run scripts/unpause-token.ts --network arb-sepolia
 *
 *   # Bulk: unpause every paused RWA in the deployment file with the
 *   # default initial NAV ($1.00 = 1000000 base units at 6 decimals):
 *   MUHAVEN_ENV=staging \
 *   pnpm hardhat run scripts/unpause-token.ts --network arb-sepolia
 *
 * Required env
 *   MUHAVEN_ENV          prod | staging — MUST be set explicitly. There
 *                        is no default; an operator who forgets this
 *                        while testing on staging would otherwise
 *                        silently target prod (or vice versa).
 *
 * Optional env
 *   MUHAVEN_TOKEN_SYMBOL TBILL1 | GOLD1 | TBILL2 | … — single token
 *                        instead of "every paused token in the registry".
 *   MUHAVEN_INITIAL_NAV  PUSDC base units / share. Defaults to 1000000
 *                        (= $1.00 at 6 decimals) which suits stable assets.
 *                        For non-yielding placeholders pass any positive
 *                        value (the oracle rejects zero).
 *
 * Pre-flight you must own
 *   - The deployer wallet's PRIVATE_KEY (TokenRegistry + Oracle owner) —
 *     set in `.env` at the project root, picked up by `hardhat.config.ts`.
 *
 * Idempotent: if a token is already unpaused, the script logs "skipped"
 * and moves on. Safe to re-run.
 */

import { ethers, network } from "hardhat";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const REGISTRY_ABI = [
  "function getConfig(address token) view returns (tuple(bool active, address treasury, address queue, address oracle, address issuer, uint128 minInvestment, uint128 instantRedeemCap, uint32 epochDuration, bool paused))",
  "function setPaused(address token, bool paused)",
  "function getRegisteredTokens(uint256 offset, uint256 limit) view returns (address[])",
  "function owner() view returns (address)",
];

const ORACLE_ABI = [
  "function getNAV(address token) view returns (uint256 nav, uint64 timestamp)",
  "function setNAV(address token, uint256 newNav)",
  "function setNavWriter(address token, address newWriter)",
  // The view is `getNavWriter`, not `navWriter`. Earlier drafts of this
  // script declared `navWriter(address)`, which has no matching selector
  // on `IssuerControlledOracle` and reverts at the static-call layer
  // — see IIssuerControlledOracle.sol:86 + impl line 293.
  "function getNavWriter(address token) view returns (address)",
  "function owner() view returns (address)",
];

const TOKEN_ABI = [
  "function symbol() view returns (string)",
  "function name() view returns (string)",
];

const DEFAULT_INITIAL_NAV = 1_000_000n; // $1.00 at 6 decimals

function deploymentPath(env: string): string {
  const suffix = env === "staging" ? ".staging" : "";
  return join(__dirname, "..", "deployments", `arb-sepolia-v2${suffix}.json`);
}

interface Job {
  symbol: string;
  tokenAddr: string;
  config: {
    paused: boolean;
    issuer: string;
    oracle: string;
  };
}

async function main() {
  const rawEnv = process.env.MUHAVEN_ENV;
  if (!rawEnv || rawEnv.trim() === "") {
    throw new Error(
      `MUHAVEN_ENV is required (must be "prod" or "staging"). ` +
        `No default — set it explicitly so prod and staging can never be confused.`,
    );
  }
  const env = rawEnv.toLowerCase();
  if (env !== "prod" && env !== "staging") {
    throw new Error(`MUHAVEN_ENV must be "prod" or "staging", got "${rawEnv}"`);
  }

  const initialNav = BigInt(
    process.env.MUHAVEN_INITIAL_NAV ?? DEFAULT_INITIAL_NAV.toString(),
  );
  if (initialNav <= 0n) {
    throw new Error(
      `MUHAVEN_INITIAL_NAV must be a positive integer (PUSDC base units), got ${initialNav}`,
    );
  }

  const path = deploymentPath(env);
  if (!existsSync(path)) throw new Error(`Deployment file not found: ${path}`);
  const deployment = JSON.parse(readFileSync(path, "utf-8"));

  const registryAddr: string = deployment.contracts.TokenRegistry.proxy;
  const oracleAddr: string = deployment.contracts.IssuerControlledOracle.proxy;
  if (!registryAddr || registryAddr === ethers.ZeroAddress) {
    throw new Error("TokenRegistry proxy not configured in deployment file");
  }
  if (!oracleAddr || oracleAddr === ethers.ZeroAddress) {
    throw new Error("IssuerControlledOracle proxy not configured in deployment file");
  }

  const [signer] = await ethers.getSigners();
  const registry = new ethers.Contract(registryAddr, REGISTRY_ABI, signer);
  const oracle = new ethers.Contract(oracleAddr, ORACLE_ABI, signer);

  console.log(`Network     : ${network.name}`);
  console.log(`Env         : ${env}`);
  console.log(`Registry    : ${registryAddr}`);
  console.log(`Oracle      : ${oracleAddr}`);
  console.log(`Signer      : ${signer.address}`);
  console.log(`InitialNAV  : ${initialNav.toString()} (= $${(Number(initialNav) / 1e6).toFixed(2)} at 6 decimals)`);

  const registryOwner: string = await registry.owner();
  if (registryOwner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `Signer is not the TokenRegistry owner. owner=${registryOwner}, signer=${signer.address}.\n` +
        `Set PRIVATE_KEY in .env to the deployer key that called the registry's constructor.`,
    );
  }
  const oracleOwner: string = await oracle.owner();
  if (oracleOwner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `Signer is not the IssuerControlledOracle owner. owner=${oracleOwner}, signer=${signer.address}.\n` +
        `Same deployer EOA owns both contracts on a normal deploy — check your env.`,
    );
  }

  // Build the job list. Either a single MUHAVEN_TOKEN_SYMBOL match, or
  // every paused token currently registered.
  const jobs: Job[] = [];
  const onlySymbol = process.env.MUHAVEN_TOKEN_SYMBOL?.trim().toUpperCase();

  // Pull every registered token from the registry (single page; bumps
  // the limit if you ever exceed 200 tokens).
  const tokenAddresses: string[] = await registry.getRegisteredTokens(0, 200);
  console.log(`Tokens      : ${tokenAddresses.length} registered\n`);

  for (const addr of tokenAddresses) {
    const tokenContract = new ethers.Contract(addr, TOKEN_ABI, signer);
    let symbol: string;
    try {
      symbol = (await tokenContract.symbol()) as string;
    } catch {
      console.log(`[?] ${addr} symbol() unreadable — skipping`);
      continue;
    }
    if (onlySymbol && symbol.toUpperCase() !== onlySymbol) continue;

    const cfg = await registry.getConfig(addr);
    jobs.push({
      symbol,
      tokenAddr: addr,
      config: {
        paused: cfg.paused,
        issuer: cfg.issuer,
        oracle: cfg.oracle,
      },
    });
  }

  if (jobs.length === 0) {
    if (onlySymbol) {
      throw new Error(`No registered token with symbol ${onlySymbol}`);
    }
    console.log("No registered tokens found. Nothing to do.");
    return;
  }

  let unpaused = 0;
  let skipped = 0;
  for (const job of jobs) {
    if (!job.config.paused) {
      console.log(`[${job.symbol}] already active — skipped`);
      skipped++;
      continue;
    }

    console.log(`[${job.symbol}] ${job.tokenAddr}`);
    console.log(`         issuer=${job.config.issuer}`);
    console.log(`         oracle=${job.config.oracle}`);

    // 1) Ensure the deployer can write NAV. The wizard set the applicant
    //    kernel as nav writer; rotate to deployer for the setNAV call,
    //    then rotate back.
    const originalWriter: string = await oracle.getNavWriter(job.tokenAddr);
    let rotatedWriter = false;
    if (originalWriter.toLowerCase() !== signer.address.toLowerCase()) {
      console.log(
        `         rotating navWriter ${originalWriter} → ${signer.address} (temporary, restored after setNAV)`,
      );
      const txA = await oracle.setNavWriter(job.tokenAddr, signer.address);
      const rcA = await txA.wait();
      console.log(`           tx ${rcA.hash} (block ${rcA.blockNumber})`);
      rotatedWriter = true;
    }

    // The setNAV call below can throw (RPC blip, deviation gate, cofhe TN
    // stall). If it does, the writer is left rotated to the deployer and
    // the applicant kernel permanently loses NAV-writer rights. Wrap so
    // the restore always runs, even on failure.
    try {
      // 2) setNAV — required for the unpause to be safe (paused-with-
      //    zero-NAV plus a follow-up unpause would let any subscription
      //    mint at NAV=0 on the next tx).
      console.log(`         setNAV(${initialNav.toString()})`);
      const txB = await oracle.setNAV(job.tokenAddr, initialNav);
      const rcB = await txB.wait();
      console.log(`           tx ${rcB.hash} (block ${rcB.blockNumber})`);
    } finally {
      // 3) Restore the applicant kernel as the NAV writer so future NAV
      //    updates remain issuer-driven. Best-effort: if restore itself
      //    throws, surface a loud manual-recovery line — the operator
      //    can then run a single setNavWriter tx by hand.
      if (rotatedWriter) {
        console.log(`         restoring navWriter → ${originalWriter}`);
        try {
          const txC = await oracle.setNavWriter(job.tokenAddr, originalWriter);
          const rcC = await txC.wait();
          console.log(`           tx ${rcC.hash} (block ${rcC.blockNumber})`);
        } catch (restoreErr) {
          console.error(
            `         ⚠ FAILED to restore navWriter for ${job.symbol}.\n` +
              `           Manual recovery (deployer key on the IssuerControlledOracle):\n` +
              `             oracle.setNavWriter(${job.tokenAddr}, ${originalWriter})`,
          );
          throw restoreErr;
        }
      }
    }

    // 4) Unpause the token in the registry.
    console.log(`         setPaused(false)`);
    const txD = await registry.setPaused(job.tokenAddr, false);
    const rcD = await txD.wait();
    console.log(`           tx ${rcD.hash} (block ${rcD.blockNumber})`);

    unpaused++;
    console.log(`         ✓ ${job.symbol} active\n`);
  }

  console.log(`Done. Unpaused ${unpaused} token(s); skipped ${skipped}.`);

  if (unpaused > 0) {
    console.log("");
    console.log("─".repeat(72));
    console.log("NEXT: how the dashboard catches up");
    console.log("─".repeat(72));
    console.log(
      "On a healthy stack the F1 indexer subscribes to TokenRegistry's\n" +
        "PausedUpdated + IssuerUpdated events and refreshes `rwa_tokens.status`\n" +
        "within ~15s of each tx mining. /tokens, /marketplace, and /portfolio\n" +
        "should all reflect the unpause without a follow-up step.\n",
    );
    console.log("If /tokens still shows the token as 'paused' after ~30s:\n");
    console.log(
      "  1. Confirm the indexer is running:\n" +
        "       curl -s https://api" +
        (env === "staging" ? "-stage" : "") +
        ".muhaven.app/health\n",
    );
    console.log(
      "  2. Recovery — re-seed from on-chain truth (refreshes existing rows):\n",
    );
    if (env === "staging") {
      console.log(
        "       ssh -i ~/.ssh/id_muhaven_vm muhaven@192.168.1.52 \\\n" +
          "         \"docker compose -f /home/muhaven/Project/Fhenix/MuHaven-stage/docker-compose.stage.yml \\\n" +
          "           -p muhaven-stage exec -T backend pnpm seed:tokens:v35\"\n",
      );
    } else {
      console.log(
        "       ssh -i ~/.ssh/id_muhaven_vm muhaven@192.168.1.52 \\\n" +
          "         \"docker compose -f /home/muhaven/Project/Fhenix/MuHaven/docker-compose.yml \\\n" +
          "           -p muhaven exec -T backend pnpm seed:tokens:v35\"\n",
      );
    }
    console.log(
      "     The seed is now refresh-aware: it point-updates `status` and\n" +
        "     `issuer_address` for existing rows when on-chain differs, and\n" +
        "     inserts new tokens when missing. Idempotent, safe to re-run.",
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
