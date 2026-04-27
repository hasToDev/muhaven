/**
 * Probe what verifier signer the @cofhe/sdk client recovers to under the
 * current SDK + verifier-service combination. Run after upgrading
 * `@cofhe/sdk`. Compares the recovered signer of a fresh `encryptInputs`
 * call against the on-chain TaskManager.verifierSigner() to definitively
 * answer whether `MuHavenStable.wrap` will succeed.
 *
 * Usage:
 *   pnpm hardhat run scripts/probe-cofhe-encrypt.ts --network arb-sepolia
 */

import { ethers, network } from "hardhat";
import { createCofheConfig, createCofheClient } from "@cofhe/sdk/node";
import { Encryptable, FheTypes } from "@cofhe/sdk";
import { arbSepolia } from "@cofhe/sdk/chains";
import { createPublicClient, createWalletClient, http, keccak256, encodePacked, recoverAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";

const TASK_MANAGER = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";
const TASK_MANAGER_ABI = ["function verifierSigner() view returns (address)"];

async function main() {
  const rpc = process.env.ARB_SEPOLIA_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc";
  const pk = process.env.PRIVATE_KEY as Hex | undefined;
  if (!pk) throw new Error("PRIVATE_KEY env var required");

  const account = privateKeyToAccount(pk);
  const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(rpc) });
  const walletClient = createWalletClient({ account, chain: arbitrumSepolia, transport: http(rpc) });

  // ── 1. On-chain expected signer ───────────────────────────────────────
  const tm = new ethers.Contract(TASK_MANAGER, TASK_MANAGER_ABI, ethers.provider);
  const expectedSigner: string = await tm.verifierSigner();
  console.log("[on-chain] TaskManager.verifierSigner():", ethers.getAddress(expectedSigner));

  // ── 2. Encrypt a uint64 via the SDK ───────────────────────────────────
  console.log("[sdk] creating client + connecting...");
  const config = createCofheConfig({ supportedChains: [arbSepolia] });
  const client = createCofheClient(config);
  await client.connect(publicClient as any, walletClient as any);

  console.log("[sdk] encryptInputs([uint64(1)]).execute() ...");
  const start = Date.now();
  const [enc] = await client
    .encryptInputs([Encryptable.uint64(1n)])
    .setAccount(account.address)
    .execute();
  console.log(`[sdk] encryptInputs done in ${Date.now() - start} ms`);

  console.log("[sdk] result", {
    ctHash: enc.ctHash.toString(),
    securityZone: enc.securityZone,
    utype: enc.utype,
    sigLen: (enc.signature as string).length,
  });

  // ── 3. Recover the signer the same way TaskManager.extractSigner does ─
  // From MockTaskManager.sol::extractSigner:
  //   keccak256(abi.encodePacked(ctHash, utype, securityZone, sender, chainid))
  const chainId = await publicClient.getChainId();
  // ctHash is bytes32 in the on-chain contract — the SDK returns a bigint.
  const ctHashHex = ("0x" + enc.ctHash.toString(16).padStart(64, "0")) as Hex;
  const expectedHash = keccak256(
    encodePacked(
      ["bytes32", "uint8", "uint8", "address", "uint256"],
      [ctHashHex, enc.utype as number, enc.securityZone, account.address, BigInt(chainId)],
    ),
  );
  const recovered = await recoverAddress({ hash: expectedHash, signature: enc.signature as Hex });
  console.log("[recover] signer derived from signature:", recovered);

  // ── 4. Verdict ────────────────────────────────────────────────────────
  if (recovered.toLowerCase() === expectedSigner.toLowerCase()) {
    console.log("\n[OK] Verifier signature matches on-chain registered key.");
    console.log("     MuHavenStable.wrap should succeed against this kernel/EOA.");
  } else {
    console.log("\n[BLOCKED] Verifier signature does NOT match on-chain expected signer.");
    console.log(`     expected (on-chain) : ${ethers.getAddress(expectedSigner)}`);
    console.log(`     recovered (verifier): ${recovered}`);
    console.log("     This is the InvalidSigner blocker — file an issue with Fhenix.");
  }

  // FheTypes for context — confirm our encoded utype matches uint64.
  console.log(`[debug] FheTypes.Uint64 = ${FheTypes.Uint64}; encoded utype = ${enc.utype}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
