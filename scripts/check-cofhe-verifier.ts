/**
 * Read-only diagnostic for the on-chain TaskManager verifier registration.
 *
 * Historical context (Phase 8 blocker, 2026-04-26 → 2026-04-28):
 * Under `@cofhe/sdk@0.4.0` the testnet verifier was returning signatures
 * recoverable to `0x3f59…4e01`, while the on-chain TaskManager has
 * `0x013a…e71` registered as `verifierSigner` — every encrypted-input write
 * reverted with `InvalidSigner(0x3f59…4e01, 0x013a…e71)` (selector
 * `0x7ba5ffb5`). The fix was the `@cofhe/sdk@0.5.1` upgrade (TFHE → 1.5.3),
 * after which the verifier signs with `0x013a…e71` again. The on-chain
 * registration never changed.
 *
 * For a definitive end-to-end probe (encrypt + recover signer, compare with
 * on-chain), run `scripts/probe-cofhe-encrypt.ts` instead. This script just
 * prints the on-chain registered signer and a brief context line.
 */

import { ethers } from "hardhat";

const TASK_MANAGER = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";
const ABI = ["function verifierSigner() view returns (address)"];

const REGISTERED_SIGNER = "0x013a19C3401B19C21390BF3f0BCdf9C01eAAfe71"; // expected since deployment
const PRE_FIX_VERIFIER_OBSERVED = "0x3f591de2a7e0efd21b05baef3e10e280362f4e01"; // what 0.4.0-era verifier returned

async function main() {
  const tm = new ethers.Contract(TASK_MANAGER, ABI, ethers.provider);
  const onChainSigner: string = await tm.verifierSigner();
  const normalized = ethers.getAddress(onChainSigner);

  console.log("TaskManager:", TASK_MANAGER);
  console.log("TaskManager.verifierSigner():", normalized);
  console.log("Registered since deployment   :", REGISTERED_SIGNER);
  console.log("Verifier-side key seen pre-fix:", ethers.getAddress(PRE_FIX_VERIFIER_OBSERVED));

  if (normalized.toLowerCase() === REGISTERED_SIGNER.toLowerCase()) {
    console.log(
      "\n[OK] On-chain registration is the long-standing key. To verify the SDK still " +
        "produces matching signatures end-to-end, run scripts/probe-cofhe-encrypt.ts.",
    );
  } else {
    console.log(
      "\n[CHANGED] On-chain verifierSigner is a third value — Fhenix may have rotated. " +
        "Re-derive the verifier-side key by running scripts/probe-cofhe-encrypt.ts.",
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
