/**
 * One-shot probe: encrypt a totalYield via cofhe Node SDK, then simulate
 * `YieldSnapshot.fundEpoch(epochId, encInput)` via eth_call to capture
 * the actual revert selector (which the bundler swallows in the normal
 * estimateGas path on Arb Sepolia).
 */

import { ethers, network } from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";
import hre from "hardhat";
import { createCofheClient } from "../tasks/utils";
import { Encryptable } from "@cofhe/sdk";

async function main() {
  const env = (process.env.MUHAVEN_ENV ?? "staging").toLowerCase();
  const symbol = process.env.MUHAVEN_TOKEN_SYMBOL ?? "TBILL1";
  const epochId = BigInt(process.env.MUHAVEN_EPOCH_ID ?? "1");
  const totalYield = BigInt(process.env.MUHAVEN_TOTAL_YIELD ?? "100000");

  const path = join(__dirname, "..", "deployments", `arb-sepolia-v2${env === "staging" ? ".staging" : ""}.json`);
  const deployment = JSON.parse(readFileSync(path, "utf-8"));
  const snapshotAddr: string = deployment.contracts.YieldSnapshot.proxy;

  const [signer] = await ethers.getSigners();
  console.log(`Signer    : ${signer.address}`);
  console.log(`Snapshot  : ${snapshotAddr}`);
  console.log(`Epoch     : ${epochId.toString()}`);
  console.log(`TotalYield: ${totalYield.toString()}\n`);

  console.log("[1] encrypting totalYield...");
  const cofheClient = await createCofheClient(hre, signer as any);
  const [enc] = await cofheClient
    .encryptInputs([Encryptable.uint128(totalYield)])
    .setAccount(signer.address)
    .execute();
  console.log(`[1] enc.ctHash=${enc.ctHash.toString()}, sigLen=${(enc.signature as string).length}`);

  const iface = new ethers.Interface([
    "function fundEpoch(uint256 epochId, (uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature) encTotalYield)",
  ]);
  const data = iface.encodeFunctionData("fundEpoch", [
    epochId,
    {
      ctHash: enc.ctHash,
      securityZone: enc.securityZone,
      utype: enc.utype,
      signature: enc.signature,
    },
  ]);

  console.log("\n[2] eth_call simulation...");
  try {
    const result = await signer.provider.call({
      to: snapshotAddr,
      from: signer.address,
      data,
    });
    console.log(`[2] simulation OK, return=${result}`);
  } catch (e: any) {
    console.log(`[2] revert:`, e.shortMessage ?? e.message);
    if (e.data) console.log(`[2] data:`, e.data);
    if (e.info?.error?.data) console.log(`[2] info.error.data:`, e.info.error.data);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
