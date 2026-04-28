/**
 * Wrap USDC → PUSDC for the deployer/issuer without going on to mhUSDC.
 * Useful for funding YieldSnapshot.fundEpoch which pulls confidential
 * PUSDC directly from the issuer (no mhUSDC layer involved).
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
