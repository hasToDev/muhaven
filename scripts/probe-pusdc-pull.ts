/**
 * Probe: simulate `legacyPusdc.confidentialTransferFrom(issuer, snapshot, amount)`
 * directly via eth_call from the YieldSnapshot contract's perspective. Bypasses
 * fundEpoch entirely so we can isolate whether the legacy PUSDC pull works at
 * all from this caller-recipient pair.
 *
 * Useful to determine if the issue is the narrow (FHE.asEuint64(euint128)) or
 * something else in the legacy PUSDC's check logic.
 */

import { ethers } from "hardhat";
import hre from "hardhat";
import { createCofheClient } from "../tasks/utils";
import { Encryptable } from "@cofhe/sdk";

const PUSDC = "0x6b6e6479b8b3237933c3ab9d8be969862d4ed89f";
const SNAPSHOT = "0x6d5C0E40f53c702CDc4923acccbdD6F45cBD3E29";

async function main() {
  const [signer] = await ethers.getSigners();
  console.log(`Signer (issuer): ${signer.address}`);
  console.log(`PUSDC          : ${PUSDC}`);
  console.log(`Snapshot (to)  : ${SNAPSHOT}\n`);

  // Encrypt a uint64 amount directly — no narrow involved.
  console.log("[1] encrypt 100000 as InEuint64 (direct, no narrow)...");
  const cofheClient = await createCofheClient(hre, signer as any);
  const [enc] = await cofheClient
    .encryptInputs([Encryptable.uint64(100000n)])
    .setAccount(SNAPSHOT) // setAccount = msg.sender of the consuming contract = SNAPSHOT
    .execute();
  console.log(`[1] enc.ctHash=${enc.ctHash.toString()}, sigLen=${(enc.signature as string).length}\n`);

  // Build calldata for the uint256 selector path. We can't call this directly
  // from issuer (the FHE.allow chain expects msg.sender to be the verifying
  // caller); instead, simulate a full subcall: pretend snapshot is the caller.
  const sel = ethers.id("confidentialTransferFrom(address,address,uint256)").slice(0, 10);
  const data = sel + ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "uint256"],
    [signer.address, SNAPSHOT, enc.ctHash],
  ).slice(2);

  console.log(`[2] eth_call from=${SNAPSHOT} to=PUSDC...`);
  try {
    const res = await signer.provider.call({
      to: PUSDC,
      from: SNAPSHOT,
      data,
    });
    console.log(`[2] simulation OK, return=${res || "(empty)"}`);
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
