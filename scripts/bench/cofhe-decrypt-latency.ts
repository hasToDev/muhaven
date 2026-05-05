/**
 * scripts/bench/cofhe-decrypt-latency.ts
 *
 * Wave 4 — Phase P0 latency benchmark.
 *
 * Measures the end-to-end latency of the two CoFHE decrypt paths against
 * a live Arbitrum Sepolia + Fhenix CoFHE testnet deployment:
 *
 *   (a) decryptForTx — used by P6 breach-path:
 *       client encryptInputs → setValue tx → cofheClient.decryptForTx(handle)
 *       .withPermit().execute() — returns {decryptedValue, signature}.
 *       Off-chain TN call; signature is what a contract would later
 *       on-chain-verify via FHE.checkSignature when committing the
 *       cleartext result. Latency we report is the off-chain leg only;
 *       add ~250ms-1s for one Arb Sepolia tx for the on-chain commit.
 *
 *   (b) decryptForView — used by every UI hot-path read:
 *       client encryptInputs → setValue tx → cofheClient.decryptForView()
 *       .execute() — returns the plaintext bigint with no signature
 *       (the verifier still authorizes via permit ACL but no on-chain
 *       commit step is possible). Used wherever a view is sufficient.
 *
 * NOTE: The deprecated `ITaskManager.createDecryptTask` + polling
 * `FHE.getDecryptResultSafe` path is no longer functional on Arb Sepolia
 * with cofhe-contracts v0.1.3 + cofhe SDK v0.5.1 (it reverts on testnet).
 * Both paths above are pure off-chain RPC calls to the Threshold Network;
 * no on-chain decrypt-task tx needed.
 *
 * Run
 * ---
 *   PRIVATE_KEY=0x...  ARB_SEPOLIA_RPC_URL=https://...  \
 *     pnpm hardhat run scripts/bench/cofhe-decrypt-latency.ts --network arb-sepolia
 *
 * Or (env from .env):
 *
 *   pnpm run bench:cofhe-latency
 *
 * Flags (env)
 * -----------
 *   BENCH_ITERATIONS=10            — number of round-trips per path (default 10)
 *   BENCH_TARGET_ADDRESS=0x...     — reuse a previously-deployed BenchTarget
 *                                    instead of deploying a fresh one. Skip
 *                                    if absent — the script auto-deploys and
 *                                    prints the address.
 *   BENCH_OUT=development/DEV_WAVE_4/latency-bench-results.json
 *                                    output JSON path (default shown)
 *
 * Output
 * ------
 *   - Pretty-printed table of per-iteration measurements + summary statistics
 *   - JSON file at BENCH_OUT with raw measurements + p50 / p90 / p99 stats
 *   - Markdown summary appended to development/DEV_WAVE_4/LATENCY_BENCH_REPORT.md
 *
 * Cost estimate (testnet)
 * -----------------------
 *   - One BenchTarget deploy ≈ 0.001 ETH (one-shot)
 *   - Per-iteration: setValue tx (~0.0001 ETH) — both decrypt paths are off-chain
 *   - 10 iterations ≈ 0.002 ETH end-to-end (Arb Sepolia testnet ETH)
 *
 * Notes
 * -----
 *   - The script targets a single network: `arb-sepolia`. It refuses to run
 *     on `hardhat` (no real CoFHE coprocessor) or any other network.
 *   - Each iteration uses a freshly-encrypted random uint64 — content-
 *     addressed handle reuse from the cofhe-mock layer does NOT apply on
 *     testnet, so each iteration is a real cryptographic round-trip.
 *   - The decryptForTx path's tail latency is dominated by Threshold Network
 *     batch scheduling; p99 is more informative than p50 for P6 breach-path
 *     UX budgeting.
 */

import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import { ethers, network } from "hardhat";
import hre from "hardhat";
import { Encryptable, FheTypes } from "@cofhe/sdk";
import { createCofheClient } from "../../tasks/utils";

const ARB_SEPOLIA_CHAIN_ID = 421614;

// ── Tiny stats helpers (avoid adding a runtime dep) ─────────────────────
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summary(samples: number[]) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: Math.round(sum / sorted.length),
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
  };
}

function fmt(n: number) {
  return `${n.toFixed(0).padStart(6, " ")} ms`;
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  // --- Network gate -----------------------------------------------------
  if (network.name !== "arb-sepolia") {
    throw new Error(
      `This bench targets arb-sepolia only. Current network: ${network.name}. ` +
        `Run with --network arb-sepolia.`,
    );
  }
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== ARB_SEPOLIA_CHAIN_ID) {
    throw new Error(`Unexpected chainId ${chainId} (expected ${ARB_SEPOLIA_CHAIN_ID}).`);
  }

  const iterations = Number(process.env.BENCH_ITERATIONS || 10);
  const outPath = path.resolve(
    process.env.BENCH_OUT || "development/DEV_WAVE_4/latency-bench-results.json",
  );
  const reportPath = path.resolve(
    "development/DEV_WAVE_4/LATENCY_BENCH_REPORT.md",
  );

  console.log("\n=== CoFHE Decrypt Latency Bench (Wave 4 P0) ===");
  console.log(`Network:        ${network.name}`);
  console.log(`Chain ID:       ${chainId}`);
  console.log(`Iterations:     ${iterations}`);
  console.log(`Output JSON:    ${outPath}`);
  console.log(`Output report:  ${reportPath}\n`);

  const [signer] = await ethers.getSigners();
  console.log(`Signer:         ${signer.address}`);
  const balEth = await ethers.provider.getBalance(signer.address);
  console.log(`ETH balance:    ${ethers.formatEther(balEth)} ETH\n`);
  if (balEth < ethers.parseEther("0.005")) {
    console.warn(
      "⚠  Low ETH balance. The bench needs ~0.005 ETH to comfortably run 10 iterations.\n",
    );
  }

  // --- Deploy or load BenchTarget ---------------------------------------
  let benchTargetAddress = process.env.BENCH_TARGET_ADDRESS as string | undefined;
  let benchTarget: any;

  if (benchTargetAddress) {
    console.log(`Using existing BenchTarget at ${benchTargetAddress}`);
    benchTarget = await ethers.getContractAt("BenchTarget", benchTargetAddress);
  } else {
    console.log("Deploying fresh BenchTarget...");
    const Factory = await ethers.getContractFactory("BenchTarget");
    const deployStart = Date.now();
    benchTarget = await Factory.deploy();
    await benchTarget.waitForDeployment();
    benchTargetAddress = await benchTarget.getAddress();
    console.log(
      `Deployed BenchTarget at ${benchTargetAddress} in ${Date.now() - deployStart} ms`,
    );
    console.log(
      `   To reuse on next run: BENCH_TARGET_ADDRESS=${benchTargetAddress}\n`,
    );
  }

  // --- CoFHE client -----------------------------------------------------
  console.log("Connecting CoFHE client...");
  const cofheClient = await createCofheClient(hre, signer);
  console.log("CoFHE client ready.\n");

  // --- Per-iteration measurements ---------------------------------------
  type IterRecord = {
    i: number;
    randomValue: string; // bigint as string
    encryptMs: number;
    setValueMs: number;
    setValueGas: string;
    decryptForTxMs: number;
    decryptForTxValue: string;
    decryptForTxSigLen: number;
    decryptForTxErr: string | null;
    decryptForViewMs: number;
    decryptForViewValue: string;
    decryptForViewErr: string | null;
  };

  const records: IterRecord[] = [];

  for (let i = 0; i < iterations; i++) {
    const sectionStart = Date.now();
    console.log(`── Iteration ${i + 1} / ${iterations} ──`);

    // 1. Encrypt a fresh random uint64. crypto.randomBytes covers the full
    //    uint64 range; Math.random would cap us at 2^53 (Number.MAX_SAFE_INTEGER)
    //    and bias the upper 11 bits to zero, which would skew handle uniqueness
    //    on testnet where the cofhe-mock content-addressing does not apply.
    const randomValue = BigInt("0x" + randomBytes(8).toString("hex"));
    const encStart = Date.now();
    const [enc] = (await cofheClient
      .encryptInputs([Encryptable.uint64(randomValue)])
      .execute()) as any[];
    const encryptMs = Date.now() - encStart;
    console.log(`  encryptInputs:    ${fmt(encryptMs)}  (val=${randomValue})`);

    // 2. setValue tx (writes the encrypted handle on-chain, grants ACLs)
    const sStart = Date.now();
    const setTx = await benchTarget.setValue(enc);
    const setRcpt = await setTx.wait();
    const setValueMs = Date.now() - sStart;
    if (!setRcpt) {
      throw new Error(
        `setValue tx ${setTx.hash} returned a null receipt — provider dropped the tx? Aborting bench.`,
      );
    }
    console.log(
      `  setValue tx:      ${fmt(setValueMs)}  gas=${setRcpt.gasUsed.toString()}`,
    );

    // 3. Pull the on-chain handle for both decrypt paths.
    const handle = (await benchTarget.valueHandle()) as bigint;

    // 4. decryptForTx path — TN-signed decrypt suitable for on-chain
    //    verification (used in P6's breach signal path).
    const tStart = Date.now();
    let dtxValue = 0n;
    let dtxSigLen = 0;
    let dtxErr: string | null = null;
    try {
      const result = await cofheClient
        .decryptForTx(handle)
        .withPermit()
        .execute();
      dtxValue = BigInt(result.decryptedValue.toString());
      dtxSigLen = (result.signature as string).length;
    } catch (e: any) {
      dtxErr = e?.message || String(e);
    }
    const decryptForTxMs = Date.now() - tStart;
    if (dtxErr) {
      console.warn(`  ⚠  decryptForTx failed: ${dtxErr}`);
    } else {
      console.log(
        `  decryptForTx:     ${fmt(decryptForTxMs)}  val=${dtxValue}  sigLen=${dtxSigLen}`,
      );
      if (dtxValue !== randomValue) {
        console.warn(
          `  ⚠  decryptForTx value mismatch! got=${dtxValue} expected=${randomValue}`,
        );
      }
    }

    // 5. decryptForView path — permit-based view used on every UI read.
    const vStart = Date.now();
    let dvValue = 0n;
    let dvErr: string | null = null;
    try {
      dvValue = (await cofheClient
        .decryptForView(handle, FheTypes.Uint64)
        .execute()) as bigint;
    } catch (e: any) {
      dvErr = e?.message || String(e);
    }
    const decryptForViewMs = Date.now() - vStart;
    if (dvErr) {
      console.warn(`  ⚠  decryptForView failed: ${dvErr}`);
    } else {
      console.log(
        `  decryptForView:   ${fmt(decryptForViewMs)}  val=${dvValue}`,
      );
      if (dvValue !== randomValue) {
        console.warn(
          `  ⚠  decryptForView value mismatch! got=${dvValue} expected=${randomValue}`,
        );
      }
    }

    records.push({
      i: i + 1,
      randomValue: randomValue.toString(),
      encryptMs,
      setValueMs,
      setValueGas: setRcpt.gasUsed.toString(),
      decryptForTxMs,
      decryptForTxValue: dtxValue.toString(),
      decryptForTxSigLen: dtxSigLen,
      decryptForTxErr: dtxErr,
      decryptForViewMs,
      decryptForViewValue: dvValue.toString(),
      decryptForViewErr: dvErr,
    });

    console.log(`  iteration total:  ${fmt(Date.now() - sectionStart)}\n`);
  }

  // --- Summary ----------------------------------------------------------
  const summarize = {
    encrypt: summary(records.map((r) => r.encryptMs)),
    setValue: summary(records.map((r) => r.setValueMs)),
    decryptForTx: summary(
      records.filter((r) => r.decryptForTxErr === null).map((r) => r.decryptForTxMs),
    ),
    decryptForView: summary(
      records.filter((r) => r.decryptForViewErr === null).map((r) => r.decryptForViewMs),
    ),
  };

  const decryptForTxSuccessRate =
    records.filter((r) => r.decryptForTxErr === null).length / records.length;
  const decryptForViewSuccessRate =
    records.filter((r) => r.decryptForViewErr === null).length / records.length;

  console.log("\n=== Summary ===");
  const rows: [string, ReturnType<typeof summary>][] = [
    ["encryptInputs", summarize.encrypt],
    ["setValue tx", summarize.setValue],
    ["decryptForTx (TN)", summarize.decryptForTx],
    ["decryptForView", summarize.decryptForView],
  ];
  console.log(
    "Path                          n      min      p50      p90      p99      max     mean",
  );
  console.log(
    "----------------------------- --- -------- -------- -------- -------- -------- --------",
  );
  for (const [name, s] of rows) {
    if (!s) {
      console.log(`${name.padEnd(30)} (no samples — all failed?)`);
      continue;
    }
    console.log(
      `${name.padEnd(30)} ${String(s.n).padStart(3)} ${fmt(s.min)} ${fmt(
        s.p50,
      )} ${fmt(s.p90)} ${fmt(s.p99)} ${fmt(s.max)} ${fmt(s.mean)}`,
    );
  }
  console.log(
    `\ndecryptForTx success rate:   ${(decryptForTxSuccessRate * 100).toFixed(1)}% (${
      records.filter((r) => r.decryptForTxErr === null).length
    }/${records.length})`,
  );
  console.log(
    `decryptForView success rate: ${(decryptForViewSuccessRate * 100).toFixed(1)}% (${
      records.filter((r) => r.decryptForViewErr === null).length
    }/${records.length})`,
  );

  // --- Persist results --------------------------------------------------
  const out = {
    network: network.name,
    chainId,
    signer: signer.address,
    benchTarget: benchTargetAddress,
    timestamp: new Date().toISOString(),
    iterations,
    decryptForTxSuccessRate,
    decryptForViewSuccessRate,
    summary: summarize,
    records,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWrote raw results → ${outPath}`);

  // --- Append a markdown summary block to the report ---------------------
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const md = renderMarkdownAppendix(out);
  if (fs.existsSync(reportPath)) {
    fs.appendFileSync(reportPath, "\n" + md);
    console.log(`Appended summary → ${reportPath}`);
  } else {
    fs.writeFileSync(reportPath, renderMarkdownReport(out));
    console.log(`Wrote new report → ${reportPath}`);
  }

  console.log(
    "\nDone. Compare against P6 latency targets in development/DEV_WAVE_4/LATENCY_BENCH_PLAN.md §'Targets'.",
  );
}

function renderMarkdownAppendix(out: any): string {
  const ts = out.timestamp;
  const s = out.summary;
  const fmtRow = (label: string, x: any) =>
    x
      ? `| ${label} | ${x.n} | ${x.min} | ${x.p50} | ${x.p90} | ${x.p99} | ${x.max} | ${x.mean} |`
      : `| ${label} | 0 | — | — | — | — | — | — |`;
  return [
    `## Run @ ${ts}`,
    ``,
    `- **Network**: ${out.network} (chainId ${out.chainId})`,
    `- **Iterations**: ${out.iterations}`,
    `- **BenchTarget**: \`${out.benchTarget}\``,
    `- **decryptForTx success rate**: ${(out.decryptForTxSuccessRate * 100).toFixed(1)}%`,
    `- **decryptForView success rate**: ${(out.decryptForViewSuccessRate * 100).toFixed(1)}%`,
    ``,
    `| Path | n | min | p50 | p90 | p99 | max | mean |`,
    `|---|---|---|---|---|---|---|---|`,
    fmtRow("encryptInputs", s.encrypt),
    fmtRow("setValue tx", s.setValue),
    fmtRow("decryptForTx (TN)", s.decryptForTx),
    fmtRow("decryptForView", s.decryptForView),
    ``,
    `Raw JSON: \`development/DEV_WAVE_4/latency-bench-results.json\``,
    ``,
    `---`,
  ].join("\n");
}

function renderMarkdownReport(out: any): string {
  return (
    [
      `# CoFHE Decrypt Latency Bench Report`,
      ``,
      `> Auto-generated by \`scripts/bench/cofhe-decrypt-latency.ts\`. Each invocation appends a new section. See \`LATENCY_BENCH_PLAN.md\` for methodology + interpretation.`,
      ``,
      `---`,
      ``,
    ].join("\n") + renderMarkdownAppendix(out)
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
