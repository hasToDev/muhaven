/**
 * scripts/probe-legacy-pusdc-selectors.ts
 *
 * READ-ONLY. Probes the live legacy PUSDC (ReineiraOS ConfidentialUSDC) on
 * Arb Sepolia for the 4-byte function selectors that Wave 5 W3 Phase 9's
 * stranded-PUSDC recovery depends on, BEFORE we bake them into a prod
 * contract upgrade or broadcast a recovery tx.
 *
 * Codifies the lesson `feedback_verify_coprocessor_selector_before_prod_cutover`:
 * a 30s getCode + selector search beats a multi-day rollback.
 *
 * Method: fetch the deployed runtime bytecode (`eth_getCode`) and search for
 * each candidate selector's 4-byte hex. A Solidity public/external function
 * dispatcher embeds each selector as a PUSH4 constant, so a hit is strong
 * evidence the function exists; a miss is strong evidence it does NOT (modulo
 * exotic fallback-router patterns). We probe the Phase-9-assumed selectors AND
 * the ERC-7984 `unshield`/claim alternatives the ReineiraOS docs describe, so
 * the output tells us which recovery shape the deployed contract actually has.
 *
 * Usage:
 *   pnpm hardhat run scripts/probe-legacy-pusdc-selectors.ts --network arb-sepolia
 *   LEGACY_PUSDC=0x... pnpm hardhat run ... (override the default address)
 */

import { ethers, network } from "hardhat";

const DEFAULT_LEGACY_PUSDC = "0x6B6E6479B8B3237933C3ab9D8bE969862D4Ed89F";

// Candidate signatures to probe. Group A = Phase-9-assumed; Group B = ERC-7984
// FHERC20ERC20Wrapper alternatives per the ReineiraOS public docs.
const SIGNATURES = [
  // ── Group A: Phase 9 assumed (recoverStrandedPusdcStart/Claim use these) ──
  "unwrap(address,uint64)",
  "claimUnwrapped(uint256)",
  // ── Group B: ERC-7984 FHERC20ERC20Wrapper unshield/claim shapes ──
  "unshield(address,address,uint64)",
  "unshield(address,address,uint256)",
  "claimDecrypted(uint256)",
  "claim(uint256)",
  "finalizeUnshield(uint256)",
  "unwrap(uint64)",
  "unwrap(uint256)",
  // ── Sanity selectors we KNOW the legacy contract exposes (smoke the probe) ──
  "confidentialBalanceOf(address)",
  "confidentialTransfer(address,uint256)",
  "setOperator(address,uint48)",
  "wrap(address,uint256)",
];

function selectorOf(sig: string): string {
  return ethers.id(sig).slice(0, 10); // 0x + 8 hex chars
}

async function main() {
  const addr = process.env.LEGACY_PUSDC || DEFAULT_LEGACY_PUSDC;
  console.log(`── probe-legacy-pusdc-selectors ─────────────────────────`);
  console.log(`Network : ${network.name}`);
  console.log(`Target  : ${addr}`);

  const code = await ethers.provider.getCode(addr);
  const codeBytes = (code.length - 2) / 2;
  console.log(`Bytecode: ${codeBytes} bytes`);
  if (code === "0x") {
    throw new Error(`No bytecode at ${addr} — wrong address or network.`);
  }

  const lower = code.toLowerCase();
  console.log(`\n  selector   present  signature`);
  console.log(`  ─────────  ───────  ─────────`);
  for (const sig of SIGNATURES) {
    const sel = selectorOf(sig);
    const present = lower.includes(sel.slice(2));
    console.log(`  ${sel}  ${present ? "  YES  " : "  no   "}  ${sig}`);
  }

  console.log(
    `\nINTERPRETATION:\n` +
      `  • Group A (unwrap(address,uint64) + claimUnwrapped(uint256)) present\n` +
      `    ⇒ Phase 9 recovery selectors are correct; proceed.\n` +
      `  • Group A absent but Group B (unshield/claim) present\n` +
      `    ⇒ recovery design must switch to the unshield shape BEFORE the\n` +
      `       prod recovery broadcast (the wrapUsdc deposit feature is\n` +
      `       unaffected either way — it never touches the legacy contract).\n` +
      `  • Sanity selectors should all read YES; if not, the probe heuristic\n` +
      `    is unreliable for this bytecode (e.g. router/proxy) — verify via ABI.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
