import { ethers } from "hardhat";

const TASK_MANAGER = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";
const ABI = ["function verifierSigner() view returns (address)"];

const EXPECTED_VERIFIER_PRE_FIX = "0x013a19C3401B19C21390BF3f0BCdf9C01eAAfe71";
const OBSERVED_VERIFIER_FROM_REVERT = "0x3f591de2a7e0efd21b05baef3e10e280362f4e01";

async function main() {
  const tm = new ethers.Contract(TASK_MANAGER, ABI, ethers.provider);
  const onChainSigner: string = await tm.verifierSigner();
  const normalized = ethers.getAddress(onChainSigner);
  console.log("TaskManager:", TASK_MANAGER);
  console.log("TaskManager.verifierSigner():", normalized);
  console.log("Pre-fix expected (was failing):", EXPECTED_VERIFIER_PRE_FIX);
  console.log("Observed from revert (verifier service key):", ethers.getAddress(OBSERVED_VERIFIER_FROM_REVERT));

  if (normalized.toLowerCase() === OBSERVED_VERIFIER_FROM_REVERT.toLowerCase()) {
    console.log("\n[OK] Mismatch resolved. On-chain TaskManager now matches verifier service.");
  } else if (normalized.toLowerCase() === EXPECTED_VERIFIER_PRE_FIX.toLowerCase()) {
    console.log("\n[BLOCKED] Mismatch persists. TaskManager still registers the old key.");
  } else {
    console.log("\n[CHANGED] TaskManager signer is a third value — re-derive observed verifier from a fresh revert.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
