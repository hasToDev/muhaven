/**
 * Phase 9.C / L1.0 — empirical probe for `FHE.div(handle, trivial)`.
 *
 * Background:
 *   The diagnostic model in `development/DEV_WAVE_3_5/COFHE_TN_DIAGNOSTIC_GUIDE.md`
 *   flags `FHE.div` as the most failure-prone op on cofhe TN. The
 *   observed failure shape (`encRatio = div(_, sum-of-N-balances)` in
 *   `YieldSnapshot.fundEpoch`) had an aggregate-fan-in DENOMINATOR.
 *   Phase 9.C / L1 plans to introduce a `FHE.div(encShare128,
 *   trivialScale)` step in `claimYield` so issuers can fund sub-1:1
 *   yields without precision loss (RATE_SCALE = 1_000_000). Whether
 *   that TRIVIAL denominator triggers the same TN ancestry stall is
 *   unknown — that's what this probe answers.
 *
 * Recipe:
 *   1. Deploy `contracts/probes/ProbeTrivialDiv.sol` on the target
 *      network (staging arb-sepolia by default).
 *   2. Encrypt a uint128 input via the cofhe Node SDK.
 *   3. Submit `probe(encInput, FAKE_RATE, SCALE)` — runs the exact
 *      op chain L1 plans (input verify → mul by trivial rate → div
 *      by trivial scale).
 *   4. Read back the result handle from `lastResult()`.
 *   5. `decryptForView(handle, FheTypes.Uint128)` with a self-permit.
 *      Race against a 90s timeout.
 *   6. Verify the plaintext matches the expected math
 *      `(input * fakeRate) / scale` and print [OK] / [STALL] / [FAIL].
 *
 * Verdict gate (exit codes):
 *   [OK]                  exit 0  — L1 is safe to ship as planned.
 *   [STALL]               exit 1  — true ancestry stall (timeout). Fall
 *                                   through to Plan C (defer L1).
 *   [SERVICE_UNAVAILABLE] exit 2  — cofhe sealOutput service is
 *                                   transiently degraded. NOT an L1
 *                                   design issue. Retry in 10-30 min.
 *   [FAIL]                exit 3  — unexpected error (math wrong, RPC
 *                                   blew up, etc). Triage individually.
 *
 * Distinguishing STALL vs SERVICE_UNAVAILABLE matters: STALL is a
 * structural property of the op shape (the gate L1 is testing for),
 * SERVICE_UNAVAILABLE is a transient infrastructure outage. A 503
 * response in <90s is the latter; a true ancestry stall hits the
 * timeout because the SDK polls indefinitely on 204s.
 *
 * Usage:
 *   pnpm hardhat run scripts/probe-trivial-div.ts --network arb-sepolia
 *
 * Env (all optional):
 *   PROBE_INPUT       default 5000000   (5 MUSTB-equivalent in 6-dec base units)
 *   PROBE_RATE        default 40000     ($0.04 per whole token, scaled by 1e6)
 *   PROBE_SCALE       default 1000000   (= RATE_SCALE — the value under test)
 *   PROBE_TIMEOUT_MS  default 90000     (decrypt poll budget)
 */

import hre, { ethers } from "hardhat";
import { Encryptable, FheTypes } from "@cofhe/sdk";
import { createCofheClient } from "../tasks/utils";

const DEFAULT_INPUT = 5_000_000n;
const DEFAULT_RATE = 40_000n;
const DEFAULT_SCALE = 1_000_000n;
const DEFAULT_TIMEOUT_MS = 90_000;

async function main() {
  const input = BigInt(process.env.PROBE_INPUT ?? DEFAULT_INPUT.toString());
  const rate = BigInt(process.env.PROBE_RATE ?? DEFAULT_RATE.toString());
  const scale = BigInt(process.env.PROBE_SCALE ?? DEFAULT_SCALE.toString());
  const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const expected = (input * rate) / scale;

  const [signer] = await ethers.getSigners();
  const network = await signer.provider.getNetwork();
  console.log(`Network   : ${network.name} (chainId=${network.chainId})`);
  console.log(`Signer    : ${signer.address}`);
  console.log(`Input     : ${input}`);
  console.log(`Rate      : ${rate}`);
  console.log(`Scale     : ${scale}`);
  console.log(`Expected  : (${input} * ${rate}) / ${scale} = ${expected}`);
  console.log(`Timeout   : ${timeoutMs} ms\n`);

  // ── 1. Deploy the probe contract ────────────────────────────────────
  console.log("[1] deploying ProbeTrivialDiv...");
  const factory = await ethers.getContractFactory("ProbeTrivialDiv", signer);
  const probe = await factory.deploy();
  await probe.waitForDeployment();
  const probeAddr = await probe.getAddress();
  console.log(`[1] deployed at ${probeAddr}\n`);

  // ── 2. Build the cofhe client + encrypt input ───────────────────────
  console.log("[2] connecting cofhe client + creating self-permit...");
  const cofheClient = await createCofheClient(hre, signer as any);

  console.log(`[2] encryptInputs([uint128(${input})])...`);
  const encStart = Date.now();
  const [enc] = await cofheClient
    .encryptInputs([Encryptable.uint128(input)])
    .setAccount(signer.address)
    .execute();
  console.log(`[2] encrypt done in ${Date.now() - encStart} ms`);
  console.log(`[2] enc.ctHash=${enc.ctHash.toString()}\n`);

  // ── 3. Submit the probe tx ──────────────────────────────────────────
  console.log("[3] submitting probe tx (mul → div by trivial)...");
  const txStart = Date.now();
  const tx = await probe.probe(
    {
      ctHash: enc.ctHash,
      securityZone: enc.securityZone,
      utype: enc.utype,
      signature: enc.signature,
    },
    rate,
    scale
  );
  const receipt = await tx.wait();
  console.log(`[3] mined in ${Date.now() - txStart} ms · gas=${receipt?.gasUsed}`);
  console.log(`[3] tx=${receipt?.hash}\n`);

  // ── 4. Read back the result handle ──────────────────────────────────
  console.log("[4] reading lastResult()...");
  const resultHandle: string = await probe.lastResult();
  const resultHandleBig = BigInt(resultHandle);
  console.log(`[4] result handle = ${resultHandle}\n`);

  if (resultHandleBig === 0n) {
    console.log("[VERDICT] FAIL — result handle is zero (probe contract didn't store it).");
    process.exit(2);
  }

  // ── 5. Attempt decrypt with timeout ─────────────────────────────────
  console.log(`[5] decryptForView(handle, Uint128) with ${timeoutMs}ms timeout...`);
  const decryptStart = Date.now();
  let plaintext: bigint | null = null;
  let lastPoll = { attemptIndex: 0, elapsedMs: 0, requestId: "" };

  try {
    plaintext = await Promise.race<bigint>([
      cofheClient
        .decryptForView(resultHandleBig, FheTypes.Uint128)
        .onPoll((ctx: any) => {
          lastPoll = {
            attemptIndex: ctx.attemptIndex,
            elapsedMs: ctx.elapsedMs,
            requestId: ctx.requestId,
          };
          if (ctx.attemptIndex % 5 === 0) {
            console.log(
              `    poll #${ctx.attemptIndex} · ${ctx.elapsedMs}ms · requestId=${ctx.requestId || "(none yet)"}`
            );
          }
        })
        .execute() as Promise<bigint>,
      new Promise<bigint>((_, reject) =>
        setTimeout(
          () => reject(new Error(`decrypt timeout after ${timeoutMs}ms`)),
          timeoutMs
        )
      ),
    ]);
  } catch (err: any) {
    const elapsed = Date.now() - decryptStart;
    const msg = String(err?.message ?? err);
    console.log(`[5] decrypt failed after ${elapsed} ms: ${msg}`);
    console.log(`    last poll: attempt=${lastPoll.attemptIndex}, requestId=${lastPoll.requestId || "(none)"}`);
    console.log("");

    // Classify the failure. SDK error messages mirror the underlying
    // sealOutput HTTP response — see decryption-lifecycle.mdx:
    //   503 / "Service Unavailable" → cofhe service degraded (not L1).
    //   timeout (≥ budget − 1s) with 204 polling → true ancestry stall.
    //   404 after retry window → handle never registered (RPC / chain).
    //   403 / "forbidden" / "ACL" → ACL grant missing (probe bug — we
    //                                stamp it explicitly, so this would
    //                                indicate a deeper SDK issue).
    const isServiceUnavailable = /service unavailable|^503|http 503| 503 /i.test(msg);
    const isAclDenied = /\b403\b|forbidden|acl/i.test(msg);
    const isHandleUnknown = /\b404\b|not found|unknown/i.test(msg);
    const hitTimeout = elapsed >= timeoutMs - 1500;

    if (isServiceUnavailable) {
      console.log("[VERDICT] SERVICE_UNAVAILABLE — cofhe sealOutput service is degraded.");
      console.log("          This is transient infrastructure, NOT an L1 design issue.");
      console.log("          The on-chain tx succeeded (gas accounted for); only the");
      console.log("          off-chain decrypt path failed. Retry in 10-30 minutes; if");
      console.log("          the failure persists, check Fhenix's status / support");
      console.log(`          channels. Probe tx: ${receipt?.hash}`);
      process.exit(2);
    }

    if (hitTimeout) {
      console.log("[VERDICT] STALL — `FHE.div(handle, trivial)` did NOT resolve within budget.");
      console.log("          L1 cannot ship the scaled-div math safely. Fall through to Plan C");
      console.log("          (defer L1; ship L2 + L3 only). Update PHASE9C_PLAN.md §3.4 with");
      console.log("          this evidence + the failing tx hash:");
      console.log(`            ${receipt?.hash}`);
      process.exit(1);
    }

    if (isAclDenied) {
      console.log("[VERDICT] FAIL — 403 ACL denied. Probe contract grants ACL explicitly,");
      console.log("          so this would indicate a deeper SDK / permit issue. Inspect");
      console.log(`          tx ${receipt?.hash} TaskManager events for the result handle's grants.`);
      process.exit(3);
    }

    if (isHandleUnknown) {
      console.log("[VERDICT] FAIL — 404 handle unknown. Coprocessor hasn't observed the");
      console.log("          ctHash within the SDK's 404-retry window. Either RPC lag or");
      console.log("          a chain-environment mismatch (probe deployed on a different");
      console.log(`          chain than the cofhe client targets). Probe tx: ${receipt?.hash}`);
      process.exit(3);
    }

    console.log("[VERDICT] FAIL — unexpected error shape; classify manually.");
    console.log(`          Probe tx: ${receipt?.hash}`);
    process.exit(3);
  }

  const decryptElapsed = Date.now() - decryptStart;
  console.log(`[5] decrypted in ${decryptElapsed} ms\n`);

  // ── 6. Verify math ──────────────────────────────────────────────────
  console.log(`[6] plaintext = ${plaintext}`);
  console.log(`[6] expected  = ${expected}`);
  if (plaintext !== expected) {
    console.log("");
    console.log("[VERDICT] FAIL — decrypt resolved but value is wrong. Math bug in probe?");
    process.exit(2);
  }

  console.log("");
  console.log("[VERDICT] OK — `FHE.div(handle, trivial)` resolves cleanly on this network.");
  console.log("          L1 is safe to ship the scaled-div math. Proceed to L1.1.");
  console.log(`          Probe tx for evidence catalog: ${receipt?.hash}`);
}

main().catch((e) => {
  console.error("\n[probe-trivial-div] unexpected error:");
  console.error(e);
  process.exit(2);
});
