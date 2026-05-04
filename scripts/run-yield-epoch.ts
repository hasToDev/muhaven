/**
 * Issuer-side yield epoch runbook (Wave 3.5). Drives the full
 * YieldSnapshot lifecycle for a single token in one shot:
 *
 *   0. (auto pre-flight) wrap `totalYield` legacy-PUSDC → mhUSDC for
 *      the issuer if `YieldSnapshot.pusdc` is the MuHavenStable wrapper
 *      (Phase 7.5 rotation, ADR-041). Skips when pusdc is still legacy.
 *      Closes the silent-shortfall failure mode where fundEpoch's
 *      `_silentFailBound` would silent-fail and every claim payout would
 *      then be silent-failed to zero. See PHASE8_BLOCKER_YIELD_CLAIM_DECRYPT
 *      §"Fix A — preflight wrap" + DEV_LOG 2026-04-28 (continuation #3).
 *   1. openEpoch(token)            — issuer
 *   2. snapshotBatch(epochId, [investors]) — paginated, issuer
 *   3. finalizeSnapshot(epochId)   — issuer
 *   4. fundEpoch(epochId, encTotalYield) — issuer pulls confidential
 *      USDC (mhUSDC post-Phase-7.5; legacy PUSDC pre-Phase-7.5)
 *
 * After step 4, every investor in the snapshot can call
 * `YieldSnapshot.claimYield(epochId, ephemeralEOA)` from the dashboard
 * (in scope of SESSION_PERMISSIONS, signs silently with session key).
 *
 * Pre-flight you must own:
 *   - **legacy PUSDC** balance ≥ totalYield on the issuer wallet
 *     (run `scripts/wrap-pusdc-only.ts` to top up from USDC if low).
 *   - The script auto-grants both operator approvals:
 *       a) `legacyPusdc.setOperator(mhUSDC, expiry)` — lets the wrapper
 *          pull legacy PUSDC during the preflight wrap.
 *       b) `mhUSDC.setOperator(yieldSnapshot, expiry)` — lets the
 *          snapshot pull mhUSDC during fundEpoch.
 *
 * Args via env:
 *   MUHAVEN_ENV          prod | staging
 *   MUHAVEN_TOKEN_SYMBOL TBILL1 | GOLD1 (must match a token in the deployment file)
 *   MUHAVEN_TOTAL_YIELD  uint128 amount of PUSDC base units (6-decimal)
 *                          e.g. "1000000000" = 1000 PUSDC
 *   MUHAVEN_TOTAL_SUPPLY uint128 outstanding token supply in base units
 *                          (Phase 9.B / Option A — issuer's off-chain ledger
 *                           value; on-chain encryptedTotalSupply is unreadable
 *                           from a script). e.g. "100000000" = 100 tokens at
 *                           6 decimals. Phase 9.C / L1 (2026-05-04):
 *                           ratePerShare =
 *                           floor(MUHAVEN_TOTAL_YIELD × RATE_SCALE /
 *                                 MUHAVEN_TOTAL_SUPPLY) where RATE_SCALE =
 *                           1_000_000. The contract divides claim payouts by
 *                           RATE_SCALE so the issuer can fund sub-1:1 yields
 *                           (e.g. 4% APY on $25 supply → $1 yield → rate
 *                           40_000). Must produce ratePerShare > 0; the floor
 *                           is now six orders of magnitude smaller than the
 *                           pre-L1 `yield ≥ supply` constraint.
 *
 * Usage:
 *   MUHAVEN_ENV=staging \
 *   MUHAVEN_TOKEN_SYMBOL=TBILL1 \
 *   MUHAVEN_TOTAL_YIELD=1000000000 \
 *   MUHAVEN_TOTAL_SUPPLY=100000000 \
 *   pnpm hardhat run scripts/run-yield-epoch.ts --network arb-sepolia
 */

import { ethers, network } from "hardhat";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { createCofheClient } from "../tasks/utils";
import { Encryptable } from "@cofhe/sdk";
import { RATE_SCALE } from "@muhaven/sdk";
import hre from "hardhat";

const SNAPSHOT_BATCH_SIZE = 50; // contract loops are ~200-investor budget; 50 is safe per tx.

const SNAPSHOT_ABI = [
  "function openEpoch(address token) returns (uint256)",
  "function snapshotBatch(uint256 epochId, address[] investors)",
  "function finalizeSnapshot(uint256 epochId)",
  "function fundEpoch(uint256 epochId, (uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature) encTotalYield, uint128 ratePerShare)",
  "function currentEpoch(address token) view returns (uint256)",
  // Field order MUST match `IYieldSnapshot.Epoch` exactly. ethers decodes
  // tuples positionally regardless of named labels — a shuffled ABI silently
  // returns wrong values (e.g. `snapshotStartTs` mis-read as `finalized`).
  "function getEpoch(uint256 epochId) view returns (tuple(address token, uint256 snapshotStartTs, uint256 snapshotEndTs, bool finalized, bool funded, bytes32 encTotalYield, bytes32 encTotalSupply, bytes32 encRatio, uint256 claimExpiry, uint256 holderCount, uint128 ratePerShare))",
];

const REGISTRY_ABI = [
  "function getHoldersPaginated(address token, uint256 offset, uint256 limit) view returns (address[])",
  "function holderCount(address token) view returns (uint256)",
];

const PUSDC_ABI = [
  "function isOperator(address holder, address spender) view returns (bool)",
  "function setOperator(address spender, uint48 until) external",
];

/// Minimal MuHavenStable surface needed for the preflight wrap step.
/// `legacyPusdc()` lets us detect whether `YieldSnapshot.pusdc` rotated
/// to the wrapper (Phase 7.5 / ADR-041); `wrap` is the wrap entrypoint;
/// the operator getters/setters are needed for both the wrap-side pull
/// (legacyPusdc → mhUSDC) and the fundEpoch-side pull (mhUSDC → snapshot).
const STABLE_ABI = [
  "function legacyPusdc() view returns (address)",
  "function wrap((uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature) encAmount, address ephemeralEOA)",
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
  const totalSupply = BigInt(envOrDie("MUHAVEN_TOTAL_SUPPLY"));
  if (totalSupply <= 0n) throw new Error("MUHAVEN_TOTAL_SUPPLY must be > 0");
  // Phase 9.C / L1 (2026-05-04) — multiply totalYield by RATE_SCALE
  // BEFORE the floor-divide so the contract's per-claim share math
  // (`balance × ratePerShare / RATE_SCALE`) recovers the un-scaled
  // share value with six fractional decimals of precision. Pre-L1
  // this was a plain `totalYield / totalSupply` — the L1 contract
  // divides by RATE_SCALE during claim, so an unscaled rate would
  // underclaim by a factor of 1e6.
  const ratePerShare = (totalYield * RATE_SCALE) / totalSupply;
  if (ratePerShare <= 0n) {
    throw new Error(
      `MUHAVEN_TOTAL_YIELD (${totalYield}) × RATE_SCALE (${RATE_SCALE}) / ` +
      `MUHAVEN_TOTAL_SUPPLY (${totalSupply}) floors to 0 — every claim ` +
      `would silent-fail to zero. The L1 floor is six orders of magnitude ` +
      `smaller than the pre-L1 floor; if you're hitting it, your supply is ` +
      `> 1e6 × your yield, which is unrealistic for any RWA. Verify the ` +
      `MUHAVEN_TOTAL_SUPPLY value (must be in token base units, not whole ` +
      `tokens — e.g. 100_000_000 for 100 MUSTB at 6 decimals).`,
    );
  }
  if (ratePerShare > 2n ** 128n - 1n) {
    throw new Error(`Computed ratePerShare ${ratePerShare} overflows uint128`);
  }

  const path = deploymentPath(env);
  if (!existsSync(path)) throw new Error(`Deployment file not found: ${path}`);
  const deployment = JSON.parse(readFileSync(path, "utf-8"));
  const tokens = deployment.tokens ?? {};
  const info = tokens[symbol];
  if (!info) throw new Error(`Token "${symbol}" not in deployment file`);

  const tokenAddr: string = info.contracts.MuHavenToken.proxy;
  const snapshotAddr: string = deployment.contracts.YieldSnapshot.proxy;
  const investorRegistryAddr: string = deployment.contracts.InvestorRegistry.proxy;

  const [signer] = await ethers.getSigners();

  // Read the actual `pusdc` field on YieldSnapshot rather than guessing
  // from the deployment file. Phase 7.5 rotated this from legacy PUSDC to
  // MuHavenStable; the script must grant the operator approval on whichever
  // contract YieldSnapshot will actually call (else the pull reverts
  // NotOperator from inside `confidentialTransferFrom`).
  const snapshot = new ethers.Contract(snapshotAddr, SNAPSHOT_ABI, signer);
  const pusdcAddr: string = await new ethers.Contract(
    snapshotAddr,
    ["function pusdc() view returns (address)"],
    signer.provider!,
  ).pusdc();

  console.log(`Network     : ${network.name}`);
  console.log(`Env         : ${env}`);
  console.log(`Token       : ${symbol} (${tokenAddr})`);
  console.log(`Snapshot    : ${snapshotAddr}`);
  console.log(`PusdcSrc    : ${pusdcAddr} (YieldSnapshot.pusdc — pull target)`);
  console.log(`TotalYield  : ${totalYield.toString()} (PUSDC base units)`);
  console.log(`TotalSupply : ${totalSupply.toString()} (token base units, off-chain ledger)`);
  console.log(`RatePerShare: ${ratePerShare.toString()} (scaled by RATE_SCALE=${RATE_SCALE}; floor div)`);
  console.log(`Signer      : ${signer.address}\n`);

  const registry = new ethers.Contract(investorRegistryAddr, REGISTRY_ABI, signer);
  const pusdc = new ethers.Contract(pusdcAddr, PUSDC_ABI, signer);

  // ── 0. Pre-flight wrap (only when YieldSnapshot.pusdc points at the
  //      MuHavenStable wrapper — Phase 7.5 / ADR-041 rotation).
  //
  //      Why this exists: the wrapper's `_doTransfer` applies
  //      `_silentFailBound`, so an under-funded issuer's mhUSDC float would
  //      cause `fundEpoch`'s pull to silent-fail to zero. The snapshot then
  //      sets `e.funded = true` + `_encRemaining[epoch] = encY64` (the
  //      *requested* amount, not `actualPaid`), and every `claimYield` would
  //      thereafter silent-fail to zero too — investors get a fresh
  //      ctHash that decrypts to zero-delta, indistinguishable from a
  //      genuine wrapper-transfer-completed-with-shortfall.
  //
  //      Eliminating that failure mode at the script layer: always wrap
  //      `totalYield` legacy PUSDC → mhUSDC for the issuer immediately
  //      before fundEpoch. Idempotent in effect — over-wrapping just
  //      accumulates the issuer's mhUSDC float; under-wrapping reverts
  //      loudly via the wrapper's `WrapFailed` (legacy PUSDC pull
  //      shortfall surfaces as a top-level revert, unlike the wrapper's
  //      transfer paths).
  //
  //      A contract-side equivalent ("Fix B") that loud-reverts
  //      `EpochUnderfunded` if `actualPaid != encTotalYield` is the
  //      proper structural fix — drafted in
  //      `development/DEV_WAVE_3_5/PHASE8_FIX_B_DRAFT.md`. This script
  //      step is the operational workaround that ships immediately.
  let usedWrapper = false;
  let wrapperAddr: string | null = null;
  let legacyPusdcAddr: string | null = null;
  try {
    const probe = new ethers.Contract(
      pusdcAddr,
      ["function legacyPusdc() view returns (address)"],
      signer.provider!,
    );
    legacyPusdcAddr = await probe.legacyPusdc();
    usedWrapper = legacyPusdcAddr !== null
      && legacyPusdcAddr !== ethers.ZeroAddress;
    wrapperAddr = pusdcAddr;
  } catch {
    // pusdc field is the legacy IFHERC20 (no `legacyPusdc()` getter) —
    // pre-Phase-7.5 wiring. Skip the preflight wrap.
    usedWrapper = false;
  }

  if (usedWrapper && wrapperAddr && legacyPusdcAddr) {
    console.log(
      `[pre/wrap] YieldSnapshot.pusdc → MuHavenStable wrapper (Phase 7.5 wiring)`,
    );
    console.log(`[pre/wrap]   wrapper      : ${wrapperAddr}`);
    console.log(`[pre/wrap]   legacy PUSDC : ${legacyPusdcAddr}`);

    const stable = new ethers.Contract(wrapperAddr, STABLE_ABI, signer);
    const legacy = new ethers.Contract(legacyPusdcAddr, PUSDC_ABI, signer);

    // (a) legacy PUSDC operator → wrapper, so wrap() can pull.
    const wrapOpOk: boolean = await legacy.isOperator(
      signer.address,
      wrapperAddr,
    );
    if (!wrapOpOk) {
      const expiry = BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60);
      console.log(
        `[pre/wrap] granting legacyPusdc operator → wrapper, until ${expiry}`,
      );
      const tx = await legacy.setOperator(wrapperAddr, expiry);
      console.log(`[pre/wrap]   setOperator tx: ${tx.hash}`);
      await tx.wait();
    } else {
      console.log("[pre/wrap] legacyPusdc operator on wrapper already granted");
    }

    // (b) Encrypt totalYield as uint64 (mhUSDC width) and wrap.
    //     `totalYield` env is bounded to legitimate PUSDC amounts well
    //     under uint64.max (~1.8e19), so the narrowing from uint128 to
    //     uint64 is safe; over-spec inputs would also break fundEpoch's
    //     own `FHE.asEuint64` narrow downstream — same constraint.
    if (totalYield > 2n ** 64n - 1n) {
      throw new Error(
        `MUHAVEN_TOTAL_YIELD ${totalYield} exceeds uint64 max — wrap() cannot encode it`,
      );
    }
    console.log(
      `[pre/wrap] wrapping ${totalYield.toString()} legacy PUSDC → mhUSDC (issuer pre-fund)`,
    );
    const cofheClientForWrap = await createCofheClient(hre, signer as any);
    const [encWrap] = await cofheClientForWrap
      .encryptInputs([Encryptable.uint64(totalYield)])
      .setAccount(signer.address)
      .execute();
    const wrapTx = await stable.wrap(
      {
        ctHash: encWrap.ctHash,
        securityZone: encWrap.securityZone,
        utype: encWrap.utype,
        signature: encWrap.signature,
      },
      signer.address, // ephemeralEOA — issuer's own EOA so they can decrypt their float
    );
    console.log(`[pre/wrap]   wrap tx: ${wrapTx.hash}`);
    await wrapTx.wait();
  } else {
    console.log("[pre/wrap] YieldSnapshot.pusdc is legacy IFHERC20 — skipping wrap step");
  }

  // ── 1. Pre-flight: operator approval on whichever contract YieldSnapshot
  //      pulls from (legacy PUSDC or MuHavenStable, depending on env wiring).
  const isOp: boolean = await pusdc.isOperator(signer.address, snapshotAddr);
  if (!isOp) {
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60);
    console.log(`[pre] granting ${pusdcAddr} operator → YieldSnapshot, until ${expiry}`);
    const tx = await pusdc.setOperator(snapshotAddr, expiry);
    console.log(`[pre] setOperator tx: ${tx.hash}`);
    await tx.wait();
  } else {
    console.log("[pre] operator on YieldSnapshot already granted");
  }

  // ── 2. openEpoch (or resume in-progress) ──────────────────────────
  // If `currentEpoch[token]` points at an epoch that's not yet funded, we
  // resume it instead of opening a new one. Lets the script be re-run
  // safely after a transient failure (e.g. RPC blip mid-fundEpoch) without
  // leaking an abandoned half-state epoch every retry.
  let epochId: bigint;
  const currentForToken: bigint = await snapshot.currentEpoch(tokenAddr);
  let resumed = false;
  if (currentForToken > 0n) {
    const ep = await snapshot.getEpoch(currentForToken);
    if (!ep.funded) {
      epochId = currentForToken;
      resumed = true;
      console.log(
        `[1/4] resuming in-progress epoch ${epochId.toString()} ` +
        `(finalized=${ep.finalized}, holderCount=${ep.holderCount.toString()})`,
      );
    }
  }
  if (!resumed) {
    const openTx = await snapshot.openEpoch(tokenAddr);
    console.log(`[1/4] openEpoch tx: ${openTx.hash}`);
    const rcpt = await openTx.wait();
    // Decode `EpochOpened(token, epochId)` from receipt logs.
    const iface = new ethers.Interface([
      "event EpochOpened(address indexed token, uint256 indexed epochId)",
    ]);
    let opened: bigint | null = null;
    for (const log of rcpt!.logs) {
      try {
        const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === "EpochOpened") {
          opened = parsed.args.epochId as bigint;
          break;
        }
      } catch {
        /* ignore non-matching logs */
      }
    }
    if (opened == null) throw new Error("openEpoch did not emit EpochOpened");
    epochId = opened;
    console.log(`[1/4] opened epochId = ${epochId.toString()}`);
  }
  console.log("");

  // ── 3. snapshotBatch (paginated over InvestorRegistry holders) ─────
  // Skip the whole snapshot phase if the resumed epoch is already
  // finalized — snapshotBatch reverts `SnapshotAlreadyFinalized` after
  // finalize. Capture is idempotent per (epoch, investor) within an
  // unfinalized epoch, so re-running mid-batch is safe.
  const epochAtSnapshotPhase = await snapshot.getEpoch(epochId);
  if (epochAtSnapshotPhase.finalized) {
    console.log(`[2/4] epoch ${epochId.toString()} already finalized — skipping snapshotBatch + finalize\n`);
  } else {
  const holderCount: bigint = await registry.holderCount(tokenAddr);
  console.log(`[2/4] holderCount(${symbol}) = ${holderCount.toString()}`);
  if (holderCount === 0n) {
    throw new Error("No holders to snapshot — investors must hold the token before opening an epoch");
  }

  let captured = 0n;
  for (let offset = 0n; offset < holderCount; offset += BigInt(SNAPSHOT_BATCH_SIZE)) {
    const limit = BigInt(SNAPSHOT_BATCH_SIZE);
    // Ethers v6 returns a frozen `Result` proxy from view calls. Passing
    // it directly back as a contract argument fails because ethers'
    // arg-coercion path tries to mutate the proxy in place. Spread into a
    // plain array of strings before submitting.
    const result = await registry.getHoldersPaginated(tokenAddr, offset, limit);
    const investors: string[] = Array.from(result, (a: unknown) => String(a));
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
  } // end snapshot/finalize phase

  // ── 5. fundEpoch (encrypts client-side via cofhe Node SDK) ─────────
  console.log(`[4/4] encrypting totalYield + calling fundEpoch`);
  const cofheClient = await createCofheClient(hre, signer as any);
  const [enc] = await cofheClient
    .encryptInputs([Encryptable.uint128(totalYield)])
    .setAccount(signer.address)
    .execute();

  const fundTx = await snapshot.fundEpoch(
    epochId,
    {
      ctHash: enc.ctHash,
      securityZone: enc.securityZone,
      utype: enc.utype,
      signature: enc.signature,
    },
    ratePerShare,
  );
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
