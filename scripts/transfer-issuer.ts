/**
 * scripts/transfer-issuer.ts
 *
 * Operator-only: transfer on-chain issuer rights from the current
 * `TokenRegistry.getConfig(token).issuer` (typically the deployer EOA
 * registered at `onboard-token` time) to a new issuer address — usually
 * a kernel smart account that the operator wants to use as the
 * production issuer wallet on the dashboard.
 *
 * Why this exists
 * ───────────────
 * Per `contracts/TokenRegistry.sol:setIssuer`, only the registry owner
 * (deployer) can rotate the per-token issuer. The on-chain issuer is the
 * sole address allowed to call:
 *   - YieldSnapshot.{openEpoch, snapshotBatch, finalizeSnapshot,
 *                    fundEpoch, sweepExpired}
 *   - TokenRegistry.{setPaused, setMinInvestment, setInstantRedeemCap,
 *                    setEpochDuration}
 * `onboard-token.ts` defaults `MUHAVEN_ISSUER = deployer`, so the
 * deployer ends up as the issuer for every token onboarded that way. To
 * test or run distributions from a kernel-backed issuer wallet, those
 * rights must be transferred — running this script is the lightweight
 * alternative to a full re-onboard.
 *
 * Usage
 * ─────
 *   MUHAVEN_ENV=staging \
 *   MUHAVEN_NEW_ISSUER=0x... \
 *   pnpm hardhat run scripts/transfer-issuer.ts --network arb-sepolia
 *
 *   # Transfer issuer for a single token instead of all of them:
 *   MUHAVEN_TOKEN_SYMBOL=TBILL1 \
 *   MUHAVEN_NEW_ISSUER=0x... \
 *   pnpm hardhat run scripts/transfer-issuer.ts --network arb-sepolia
 *
 * Required env
 *   MUHAVEN_ENV          prod | staging
 *   MUHAVEN_NEW_ISSUER   0x-address that receives the issuer role
 *
 * Optional env
 *   MUHAVEN_TOKEN_SYMBOL TBILL1 | GOLD1 — when set, only that token is
 *                        rotated; otherwise every registered RWA token
 *                        in the deployment file is rotated.
 *
 * Pre-flight you must own
 *   - The deployer wallet's PRIVATE_KEY (registry owner) — set in `.env`
 *     at the project root, picked up by `hardhat.config.ts`.
 *
 * Idempotent: if the current on-chain issuer already equals the new
 * value, the script logs "skipped" and moves on. Safe to re-run.
 */

import { ethers, network } from "hardhat";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const REGISTRY_ABI = [
  "function getConfig(address token) view returns (tuple(bool active, address treasury, address queue, address oracle, address issuer, uint128 minInvestment, uint128 instantRedeemCap, uint32 epochDuration, bool paused))",
  "function setIssuer(address token, address newIssuer)",
  "function owner() view returns (address)",
  "event IssuerUpdated(address indexed token, address indexed oldIssuer, address indexed newIssuer)",
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
  const newIssuerRaw = envOrDie("MUHAVEN_NEW_ISSUER");
  if (!ethers.isAddress(newIssuerRaw)) {
    throw new Error(`MUHAVEN_NEW_ISSUER is not a valid address: ${newIssuerRaw}`);
  }
  const newIssuer = ethers.getAddress(newIssuerRaw);

  const path = deploymentPath(env);
  if (!existsSync(path)) throw new Error(`Deployment file not found: ${path}`);
  const deployment = JSON.parse(readFileSync(path, "utf-8"));

  const registryAddr: string = deployment.contracts.TokenRegistry.proxy;
  if (!registryAddr || registryAddr === ethers.ZeroAddress) {
    throw new Error("TokenRegistry proxy not configured in deployment file");
  }

  const tokens = deployment.tokens ?? {};
  const onlySymbol = process.env.MUHAVEN_TOKEN_SYMBOL;
  const symbols: string[] = onlySymbol
    ? [onlySymbol]
    : Object.keys(tokens);

  if (symbols.length === 0) {
    throw new Error("No tokens found in deployment file");
  }

  const [signer] = await ethers.getSigners();
  const registry = new ethers.Contract(registryAddr, REGISTRY_ABI, signer);

  console.log(`Network    : ${network.name}`);
  console.log(`Env        : ${env}`);
  console.log(`Registry   : ${registryAddr}`);
  console.log(`NewIssuer  : ${newIssuer}`);
  console.log(`Signer     : ${signer.address}`);
  console.log(`Tokens     : ${symbols.join(", ")}\n`);

  const owner: string = await registry.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `Signer is not the TokenRegistry owner. owner=${owner}, signer=${signer.address}.\n` +
      `Set PRIVATE_KEY in .env to the deployer key that called the registry's constructor.`,
    );
  }

  let rotated = 0;
  let skipped = 0;
  for (const sym of symbols) {
    const info = tokens[sym];
    if (!info) {
      console.log(`[${sym}] NOT IN DEPLOYMENT FILE — skipping`);
      continue;
    }
    const tokenAddr: string = info.contracts.MuHavenToken.proxy;
    if (!tokenAddr || tokenAddr === ethers.ZeroAddress) {
      console.log(`[${sym}] MuHavenToken proxy missing — skipping`);
      continue;
    }

    const cfg = await registry.getConfig(tokenAddr);
    const currentIssuer: string = cfg.issuer;

    if (currentIssuer.toLowerCase() === newIssuer.toLowerCase()) {
      console.log(`[${sym}] already at ${newIssuer} — skipped`);
      skipped++;
      continue;
    }

    console.log(`[${sym}] rotating issuer ${currentIssuer} → ${newIssuer}`);
    const tx = await registry.setIssuer(tokenAddr, newIssuer);
    const receipt = await tx.wait();
    console.log(`         tx ${receipt.hash} (block ${receipt.blockNumber})`);
    rotated++;
  }

  console.log(`\nDone. Rotated ${rotated} token(s); skipped ${skipped}.`);

  if (rotated > 0) {
    console.log("");
    console.log("─".repeat(72));
    console.log("NEXT: sync the backend's `rwa_tokens.issuer_address` column");
    console.log("─".repeat(72));
    console.log(
      "On-chain issuer is rotated, but the backend's DB row is stale until\n" +
      "you run the sync. The issuer dashboard (/tokens, /distribute) reads\n" +
      "from `rwa_tokens.issuer_address`, so the new issuer won't see their\n" +
      "tokens listed until this lands.\n",
    );
    if (env === "staging") {
      console.log(
        "  ssh -i ~/.ssh/id_muhaven_vm muhaven@192.168.1.52 \\\n" +
        "    \"docker compose -f /home/muhaven/Project/Fhenix/MuHaven-stage/docker-compose.stage.yml \\\n" +
        "      -p muhaven-stage exec -T backend pnpm seed:sync-issuers\"\n",
      );
    } else {
      console.log(
        "  ssh -i ~/.ssh/id_muhaven_vm muhaven@192.168.1.52 \\\n" +
        "    \"docker compose -f /home/muhaven/Project/Fhenix/MuHaven/docker-compose.yml \\\n" +
        "      -p muhaven exec -T backend pnpm seed:sync-issuers\"\n",
      );
    }
    console.log(
      `Verify on /distribute: connect as ${newIssuer} → preflight should\nnow pass the OnlyIssuer guardrail AND list the rotated tokens.`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
