/**
 * scripts/validate-reineira.ts
 *
 * Read-only validation script — verifies ReineiraOS contracts are live on Arb Sepolia.
 * No gas required. No writes.
 *
 * Run:
 *   pnpm hardhat run scripts/validate-reineira.ts --network arb-sepolia
 */

import { ethers } from "hardhat";

// ReineiraOS Arb Sepolia addresses (source: MCP reineira-docs, 2026-04-08)
const ADDRESSES = {
  ConfidentialUSDC:        "0x6b6e6479b8b3237933c3ab9d8be969862d4ed89f",
  ConfidentialEscrow:      "0xC4333F84F5034D8691CB95f068def2e3B6DC60Fa", // proxy
  CCTPV2EscrowReceiver:    "0x48F2Ad7B9895683b865eaA5dfb852CB144895Eb7", // proxy
  SimpleCondition:         "0x9817DA50DB5CE4316D2f0fF6bb6DBfe252C29593",
  PolicyRegistry:          "0xf421363B642315BD3555dE2d9BD566b7f9213c8E", // proxy
  OperatorRegistry:        "0x1422ccC8B42079D810835631a5DFE1347a602959", // proxy
  TaskExecutor:            "0x7F24077A3341Af05E39fC232A77c21A03Bbd2262", // proxy
  FeeManager:              "0x5a11DC96CEfd2fB46759F08aCE49515aa23F0156", // proxy
  CCTPHandler:             "0xb37A83461B01097e1E440405264dA59EE9a3F273", // proxy
  CircleUSDC:              "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
  TrustedForwarder:        "0x7ceA357B5AC0639F89F9e378a1f03Aa5005C0a25",
} as const;

// Minimal ABI for ERC-20 metadata reads
const ERC20_META_ABI = [
  "function name() external view returns (string)",
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
];

type CheckResult = {
  name: string;
  address: string;
  hasCode: boolean;
  erc20?: { name: string; symbol: string; decimals: number };
  error?: string;
};

async function checkContract(
  label: string,
  address: string,
  tryErc20 = false
): Promise<CheckResult> {
  const provider = ethers.provider;
  const code = await provider.getCode(address);
  const hasCode = code !== "0x";

  if (!hasCode) {
    return { name: label, address, hasCode: false };
  }

  if (!tryErc20) {
    return { name: label, address, hasCode: true };
  }

  try {
    const token = new ethers.Contract(address, ERC20_META_ABI, provider);
    const [tokenName, symbol, decimals] = await Promise.all([
      token.name(),
      token.symbol(),
      token.decimals(),
    ]);
    return {
      name: label,
      address,
      hasCode: true,
      erc20: { name: tokenName, symbol, decimals: Number(decimals) },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: label, address, hasCode: true, error: `ERC-20 read failed: ${msg}` };
  }
}

async function main() {
  const provider = ethers.provider;
  const network = await provider.getNetwork();

  console.log(`\nReineiraOS Contract Validation`);
  console.log(`Network: ${network.name} (chainId: ${network.chainId})`);
  console.log(`Block:   ${await provider.getBlockNumber()}`);
  console.log("─".repeat(72));

  const results = await Promise.all([
    checkContract("ConfidentialUSDC",     ADDRESSES.ConfidentialUSDC,     true),
    checkContract("ConfidentialEscrow",   ADDRESSES.ConfidentialEscrow,   false),
    checkContract("CCTPV2EscrowReceiver", ADDRESSES.CCTPV2EscrowReceiver, false),
    checkContract("SimpleCondition",      ADDRESSES.SimpleCondition,      false),
    checkContract("PolicyRegistry",       ADDRESSES.PolicyRegistry,       false),
    checkContract("OperatorRegistry",     ADDRESSES.OperatorRegistry,     false),
    checkContract("TaskExecutor",         ADDRESSES.TaskExecutor,         false),
    checkContract("FeeManager",           ADDRESSES.FeeManager,           false),
    checkContract("CCTPHandler",          ADDRESSES.CCTPHandler,          false),
    checkContract("CircleUSDC",           ADDRESSES.CircleUSDC,           true),
    checkContract("TrustedForwarder",     ADDRESSES.TrustedForwarder,     false),
  ]);

  let allOk = true;

  for (const r of results) {
    const status = r.hasCode ? "✓" : "✗";
    const addrShort = `${r.address.slice(0, 10)}...${r.address.slice(-6)}`;

    if (!r.hasCode) {
      allOk = false;
      console.log(`${status} ${r.name.padEnd(24)} ${addrShort}  NO CODE — address wrong or not deployed`);
    } else if (r.erc20) {
      console.log(
        `${status} ${r.name.padEnd(24)} ${addrShort}  ${r.erc20.symbol} (${r.erc20.name}, ${r.erc20.decimals} decimals)`
      );
    } else if (r.error) {
      console.log(`${status} ${r.name.padEnd(24)} ${addrShort}  deployed  [${r.error}]`);
    } else {
      console.log(`${status} ${r.name.padEnd(24)} ${addrShort}  deployed`);
    }
  }

  console.log("─".repeat(72));
  if (allOk) {
    console.log("All contracts verified. Addresses are correct.\n");
  } else {
    console.error("Some contracts are missing. Check addresses above.\n");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
