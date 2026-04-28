/**
 * Wrap USDC → legacy confidential PUSDC for the deployer/issuer. Stops
 * at the legacy-PUSDC layer — does NOT continue to mhUSDC.
 *
 * Use this to top up the issuer's legacy-PUSDC balance before running
 * `scripts/run-yield-epoch.ts` (which itself auto-wraps the requested
 * `MUHAVEN_TOTAL_YIELD` amount of legacy PUSDC → mhUSDC during its
 * preflight, then `fundEpoch`-pulls from the issuer's mhUSDC float).
 *
 * Stale-docstring history note: pre-Phase-7.5, `YieldSnapshot.pusdc`
 * pointed directly at legacy PUSDC and `fundEpoch` pulled legacy PUSDC
 * straight from the issuer — so this script's USDC → PUSDC step was
 * sufficient prep on its own. After Phase 7.5 (ADR-041), the snapshot's
 * `pusdc` rotated to the MuHavenStable wrapper and the issuer must hold
 * **mhUSDC** for `fundEpoch` to actually pull anything; the wrap-to-mhUSDC
 * step now lives in `run-yield-epoch.ts` (search for `[pre/wrap]`). This
 * script is still the right entry point for keeping the underlying
 * legacy-PUSDC float topped up from USDC.
 *
 * Usage:
 *   WRAP_AMOUNT_USDC=1 pnpm hardhat run scripts/wrap-pusdc-only.ts --network arb-sepolia
 */

import { ethers, network } from "hardhat";

const USDC = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";
const PUSDC = "0x6b6e6479b8b3237933c3ab9d8be969862d4ed89f";

async function main() {
  const amountUsdcRaw = process.env.WRAP_AMOUNT_USDC ?? "1";
  const amountUnits = BigInt(Math.round(parseFloat(amountUsdcRaw) * 1_000_000));
  if (amountUnits <= 0n) throw new Error("WRAP_AMOUNT_USDC must be > 0");

  const [signer] = await ethers.getSigners();
  console.log(`Network : ${network.name}`);
  console.log(`Signer  : ${signer.address}`);
  console.log(`Amount  : ${amountUsdcRaw} USDC (${amountUnits.toString()} base units)\n`);

  const usdc = new ethers.Contract(
    USDC,
    [
      "function balanceOf(address) view returns (uint256)",
      "function allowance(address,address) view returns (uint256)",
      "function approve(address, uint256) returns (bool)",
    ],
    signer,
  );
  const pusdc = new ethers.Contract(
    PUSDC,
    [
      "function balanceOf(address) view returns (uint256)",
      "function wrap(address to, uint256 amount) external",
    ],
    signer,
  );

  const usdcBal: bigint = await usdc.balanceOf(signer.address);
  if (usdcBal < amountUnits) {
    throw new Error(`Insufficient USDC: have ${usdcBal}, need ${amountUnits}`);
  }

  // approve
  const allowance: bigint = await usdc.allowance(signer.address, PUSDC);
  if (allowance < amountUnits) {
    console.log("[1/2] usdc.approve(pusdc, amount)");
    const tx = await usdc.approve(PUSDC, amountUnits);
    console.log(`[1/2]   tx: ${tx.hash}`);
    await tx.wait();
  } else {
    console.log("[1/2] usdc allowance already sufficient — skipping approve");
  }

  // wrap
  console.log("[2/2] pusdc.wrap(signer, amount)");
  const tx2 = await pusdc.wrap(signer.address, amountUnits);
  console.log(`[2/2]   tx: ${tx2.hash}`);
  await tx2.wait();

  console.log("\nDone. Issuer's encrypted PUSDC balance was bumped by");
  console.log(`${amountUnits.toString()} base units (= ${amountUsdcRaw} PUSDC).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
