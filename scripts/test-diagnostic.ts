/**
 * scripts/test-diagnostic.ts
 *
 * Diagnose the PUSDC confidentialTransferFrom revert on testnet.
 *
 * Track C — Selector probe (no deployment needed):
 *   1. Compute function selectors for bytes32 vs uint256 variants
 *   2. Search ConfidentialUSDC bytecode for matching selectors
 *   3. Probe via eth_call to confirm which selectors the contract responds to
 *   4. Check supportsInterface for ERC-165 / IERC7984 / IFHERC20
 *
 * Track A — MockPUSDC on testnet (no FHE.isAllowed check):
 *   Requires deploy-diagnostic.ts first. Tests cross-contract transferFrom
 *   against a mock with real FHE ops but NO ACL gate.
 *
 * Track B — TestFHERC20 on testnet (with toggleable FHE.isAllowed check):
 *   Requires deploy-diagnostic.ts first. Tests the ACL gate in isolation.
 *
 * Usage:
 *   pnpm hardhat run scripts/test-diagnostic.ts --network arb-sepolia
 */

import { ethers, network } from "hardhat";
import hre from "hardhat";
import { createCofheClient } from "../tasks/utils";
import { Encryptable } from "@cofhe/sdk";
import { loadDeployment, getAddress, sleep } from "./testnet-utils";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

// ConfidentialUSDC on Arb Sepolia
const PUSDC_ADDRESS =
  process.env.PUSDC_ADDRESS || "0x6b6e6479b8b3237933c3ab9d8be969862d4ed89f";

// ── Helpers ───────��───────────────────────────────────────────────────────

function computeSelector(signature: string): string {
  return ethers.id(signature).slice(0, 10);
}

function computeInterfaceId(selectors: string[]): string {
  let id = 0n;
  for (const sig of selectors) {
    const hash = ethers.keccak256(ethers.toUtf8Bytes(sig));
    const selector = BigInt(hash.slice(0, 10));
    id ^= selector;
  }
  return "0x" + id.toString(16).padStart(8, "0");
}

// ── Track C: Selector Probe ───────────────────────────────────────────────

async function runTrackC() {
  console.log("\n" + "=".repeat(60));
  console.log("  TRACK C: Selector Probe (ConfidentialUSDC)");
  console.log("=".repeat(60));
  console.log(`  Target: ${PUSDC_ADDRESS}\n`);

  const provider = ethers.provider;

  // ── Step 1: Compute candidate selectors ─────────────────────────────
  console.log("--- Step 1: Compute candidate selectors ---\n");

  const selectors = {
    // confidentialTransferFrom overloads
    "transferFrom(addr,addr,bytes32)": computeSelector(
      "confidentialTransferFrom(address,address,bytes32)",
    ),
    "transferFrom(addr,addr,uint256)": computeSelector(
      "confidentialTransferFrom(address,address,uint256)",
    ),
    "transferFrom(addr,addr,InEuint64)": computeSelector(
      "confidentialTransferFrom(address,address,(uint256,uint8,uint8,bytes))",
    ),

    // confidentialTransfer overloads
    "transfer(addr,bytes32)": computeSelector(
      "confidentialTransfer(address,bytes32)",
    ),
    "transfer(addr,uint256)": computeSelector(
      "confidentialTransfer(address,uint256)",
    ),
    "transfer(addr,InEuint64)": computeSelector(
      "confidentialTransfer(address,(uint256,uint8,uint8,bytes))",
    ),

    // Other FHERC20 functions
    "isOperator(addr,addr)": computeSelector("isOperator(address,address)"),
    "setOperator(addr,uint48)": computeSelector("setOperator(address,uint48)"),
    "confidentialBalanceOf(addr)": computeSelector(
      "confidentialBalanceOf(address)",
    ),
    "confidentialTotalSupply()": computeSelector("confidentialTotalSupply()"),
    "name()": computeSelector("name()"),
    "symbol()": computeSelector("symbol()"),
    "decimals()": computeSelector("decimals()"),

    // Wrapper functions
    "wrap(addr,uint256)": computeSelector("wrap(address,uint256)"),
    "shield(addr,uint256)": computeSelector("shield(address,uint256)"),

    // ERC-165
    "supportsInterface(bytes4)": computeSelector(
      "supportsInterface(bytes4)",
    ),
  };

  for (const [name, sel] of Object.entries(selectors)) {
    console.log(`  ${sel}  ${name}`);
  }

  // ── Step 2: Search bytecode for selectors ───────────────────────────
  console.log("\n--- Step 2: Bytecode selector search ---\n");

  const bytecode = await provider.getCode(PUSDC_ADDRESS);
  if (bytecode === "0x") {
    console.log("  ERROR: No bytecode at address. Contract not deployed?");
    return;
  }
  console.log(`  Bytecode length: ${bytecode.length / 2 - 1} bytes\n`);

  // Search for each selector in the bytecode (as PUSH4 operand)
  for (const [name, sel] of Object.entries(selectors)) {
    // Remove 0x prefix for bytecode search
    const selectorHex = sel.slice(2);
    const found = bytecode.toLowerCase().includes(selectorHex.toLowerCase());
    const status = found ? "FOUND" : "NOT FOUND";
    const icon = found ? "+" : "-";
    console.log(`  [${icon}] ${sel} ${status}  ${name}`);
  }

  // ── Step 3: eth_call probes ���────────────────────────────────────────
  console.log("\n--- Step 3: eth_call probes ---\n");

  const dummyAddr = "0x0000000000000000000000000000000000000001";
  const dummyBytes32 =
    "0x0000000000000000000000000000000000000000000000000000000000000001";

  // Probe confidentialTransferFrom with bytes32 variant
  const probes = [
    {
      name: "confidentialTransferFrom(addr,addr,bytes32)",
      data:
        selectors["transferFrom(addr,addr,bytes32)"] +
        ethers.AbiCoder.defaultAbiCoder()
          .encode(["address", "address", "bytes32"], [dummyAddr, dummyAddr, dummyBytes32])
          .slice(2),
    },
    {
      name: "confidentialTransferFrom(addr,addr,uint256)",
      data:
        selectors["transferFrom(addr,addr,uint256)"] +
        ethers.AbiCoder.defaultAbiCoder()
          .encode(["address", "address", "uint256"], [dummyAddr, dummyAddr, 1n])
          .slice(2),
    },
    {
      name: "confidentialTransfer(addr,bytes32)",
      data:
        selectors["transfer(addr,bytes32)"] +
        ethers.AbiCoder.defaultAbiCoder()
          .encode(["address", "bytes32"], [dummyAddr, dummyBytes32])
          .slice(2),
    },
    {
      name: "confidentialTransfer(addr,uint256)",
      data:
        selectors["transfer(addr,uint256)"] +
        ethers.AbiCoder.defaultAbiCoder()
          .encode(["address", "uint256"], [dummyAddr, 1n])
          .slice(2),
    },
    {
      name: "isOperator(addr,addr)",
      data:
        selectors["isOperator(addr,addr)"] +
        ethers.AbiCoder.defaultAbiCoder()
          .encode(["address", "address"], [dummyAddr, dummyAddr])
          .slice(2),
    },
    {
      name: "name()",
      data: selectors["name()"],
    },
    {
      name: "symbol()",
      data: selectors["symbol()"],
    },
    {
      name: "decimals()",
      data: selectors["decimals()"],
    },
    {
      name: "wrap(addr,uint256)",
      data:
        selectors["wrap(addr,uint256)"] +
        ethers.AbiCoder.defaultAbiCoder()
          .encode(["address", "uint256"], [dummyAddr, 0n])
          .slice(2),
    },
    {
      name: "shield(addr,uint256)",
      data:
        selectors["shield(addr,uint256)"] +
        ethers.AbiCoder.defaultAbiCoder()
          .encode(["address", "uint256"], [dummyAddr, 0n])
          .slice(2),
    },
  ];

  for (const probe of probes) {
    try {
      const result = await provider.call({
        to: PUSDC_ADDRESS,
        data: probe.data,
      });
      // If we get here, the call succeeded (returned data)
      const truncated =
        result.length > 66 ? result.slice(0, 66) + "..." : result;
      console.log(`  [OK]    ${probe.name}`);
      console.log(`          result: ${truncated}`);
    } catch (err: any) {
      const revertData = err?.data ?? err?.error?.data ?? "none";
      const msg = err?.shortMessage ?? err?.message ?? "unknown";
      if (revertData && revertData !== "0x" && revertData !== "none") {
        // Meaningful revert = selector MATCHED, business logic rejected
        console.log(`  [REVERT] ${probe.name}`);
        console.log(`          data: ${revertData}`);
        // Try to decode known errors
        tryDecodeError(revertData);
      } else {
        // Empty revert or no data = likely selector MISMATCH
        console.log(`  [EMPTY]  ${probe.name}`);
        console.log(`          msg: ${msg}`);
      }
    }
  }

  // ── Step 4: ERC-165 supportsInterface ───────────────────────────────
  console.log("\n--- Step 4: ERC-165 supportsInterface ---\n");

  const ierc165Id = "0x01ffc9a7";

  const ierc7984Id = computeInterfaceId([
    "name()",
    "symbol()",
    "decimals()",
    "contractURI()",
    "confidentialTotalSupply()",
    "confidentialBalanceOf(address)",
    "isOperator(address,address)",
    "setOperator(address,uint48)",
    "confidentialTransfer(address,(uint256,uint8,uint8,bytes))",
    "confidentialTransfer(address,bytes32)",
    "confidentialTransferFrom(address,address,(uint256,uint8,uint8,bytes))",
    "confidentialTransferFrom(address,address,bytes32)",
    "confidentialTransferAndCall(address,(uint256,uint8,uint8,bytes),bytes)",
    "confidentialTransferAndCall(address,bytes32,bytes)",
    "confidentialTransferFromAndCall(address,address,(uint256,uint8,uint8,bytes),bytes)",
    "confidentialTransferFromAndCall(address,address,bytes32,bytes)",
  ]);

  // Also compute a "uint256 variant" IERC7984 to see if the contract uses uint256
  const ierc7984Uint256Id = computeInterfaceId([
    "name()",
    "symbol()",
    "decimals()",
    "contractURI()",
    "confidentialTotalSupply()",
    "confidentialBalanceOf(address)",
    "isOperator(address,address)",
    "setOperator(address,uint48)",
    "confidentialTransfer(address,(uint256,uint8,uint8,bytes))",
    "confidentialTransfer(address,uint256)",
    "confidentialTransferFrom(address,address,(uint256,uint8,uint8,bytes))",
    "confidentialTransferFrom(address,address,uint256)",
    "confidentialTransferAndCall(address,(uint256,uint8,uint8,bytes),bytes)",
    "confidentialTransferAndCall(address,uint256,bytes)",
    "confidentialTransferFromAndCall(address,address,(uint256,uint8,uint8,bytes),bytes)",
    "confidentialTransferFromAndCall(address,address,uint256,bytes)",
  ]);

  const ifherc20Id = computeInterfaceId([
    "balanceOfIsIndicator()",
    "indicatorTick()",
  ]);

  const interfaceChecks = [
    { name: "ERC-165", id: ierc165Id },
    { name: "IERC7984 (bytes32 euint64)", id: ierc7984Id },
    { name: "IERC7984 (uint256 euint64)", id: ierc7984Uint256Id },
    { name: "IFHERC20", id: ifherc20Id },
  ];

  console.log(`  Interface IDs:`);
  for (const check of interfaceChecks) {
    console.log(`    ${check.id}  ${check.name}`);
  }
  console.log();

  const supportsInterfaceSelector = selectors["supportsInterface(bytes4)"];
  for (const check of interfaceChecks) {
    try {
      const result = await provider.call({
        to: PUSDC_ADDRESS,
        data:
          supportsInterfaceSelector +
          ethers.AbiCoder.defaultAbiCoder()
            .encode(["bytes4"], [check.id])
            .slice(2),
      });
      const supported =
        result ===
        "0x0000000000000000000000000000000000000000000000000000000000000001";
      console.log(
        `  ${supported ? "[YES]" : "[NO] "} ${check.name} (${check.id})`,
      );
    } catch (err: any) {
      console.log(`  [ERR]  ${check.name}: ${err?.shortMessage ?? err?.message}`);
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────
  console.log("\n--- Track C Summary ---\n");

  const bytes32Found = bytecode
    .toLowerCase()
    .includes(selectors["transferFrom(addr,addr,bytes32)"].slice(2).toLowerCase());
  const uint256Found = bytecode
    .toLowerCase()
    .includes(selectors["transferFrom(addr,addr,uint256)"].slice(2).toLowerCase());

  if (bytes32Found && !uint256Found) {
    console.log("  RESULT: ConfidentialUSDC uses bytes32 selectors (same as our code)");
    console.log("  => Selector mismatch is NOT the cause. Investigate ACL/FHE ops.");
  } else if (!bytes32Found && uint256Found) {
    console.log("  RESULT: ConfidentialUSDC uses uint256 selectors (DIFFERENT from our code!)");
    console.log("  => SELECTOR MISMATCH CONFIRMED. euint64 underlying type differs.");
    console.log("  => Fix: use low-level call with uint256 selector, or deploy our own FHERC20.");
  } else if (bytes32Found && uint256Found) {
    console.log("  RESULT: Both selectors found in bytecode. Need eth_call results to distinguish.");
  } else {
    console.log("  RESULT: Neither selector found. The contract may use a non-standard interface.");
  }
}

// ── Track A: MockPUSDC on testnet ─���───────────────────────────────────────

async function runTrackA() {
  console.log("\n" + "=".repeat(60));
  console.log("  TRACK A: MockPUSDC (no FHE.isAllowed check)");
  console.log("=".repeat(60));

  // Load diagnostic deployment
  const diagPath = join(
    __dirname,
    "..",
    "deployments",
    `${network.name}.diagnostic.json`,
  );
  if (!existsSync(diagPath)) {
    console.log("  SKIP: No diagnostic deployment found.");
    console.log("  Run 'pnpm hardhat run scripts/deploy-diagnostic.ts --network arb-sepolia' first.");
    return;
  }

  const diag = JSON.parse(readFileSync(diagPath, "utf8"));
  const mockPusdcAddr = diag.contracts?.MockPUSDC;
  if (!mockPusdcAddr) {
    console.log("  SKIP: MockPUSDC not found in diagnostic deployment.");
    return;
  }

  const [deployer] = await ethers.getSigners();
  const deployment = loadDeployment();
  const distributorAddr = getAddress(deployment, "YieldDistributor");
  const registryAddr = getAddress(deployment, "InvestorRegistry");

  console.log(`  MockPUSDC:        ${mockPusdcAddr}`);
  console.log(`  YieldDistributor: ${distributorAddr}`);
  console.log(`  Deployer:         ${deployer.address}\n`);

  const distributor = await ethers.getContractAt("YieldDistributor", distributorAddr);
  const mockPusdc = await ethers.getContractAt("MockPUSDC", mockPusdcAddr);
  const registry = await ethers.getContractAt("InvestorRegistry", registryAddr);

  // Check investor count
  const investorCount = await registry.investorCount();
  if (investorCount === 0n) {
    console.log("  SKIP: No investors registered. Run test-testnet.ts first.");
    return;
  }
  console.log(`  Investors: ${investorCount}`);

  // Step 1: Point distributor at MockPUSDC
  console.log("\n  Step 1: Switch distributor to MockPUSDC...");
  const currentPusdc = await distributor.pusdc();
  console.log(`  Current PUSDC: ${currentPusdc}`);

  if (currentPusdc.toLowerCase() !== mockPusdcAddr.toLowerCase()) {
    const switchTx = await distributor.setPusdc(mockPusdcAddr);
    await switchTx.wait();
    console.log(`  Switched to MockPUSDC: ${switchTx.hash}`);
  } else {
    console.log(`  Already pointing at MockPUSDC`);
  }

  // Step 2: Mint MockPUSDC to deployer
  console.log("\n  Step 2: Mint MockPUSDC...");
  const mintAmount = 10_000_000n; // 10 PUSDC (6 decimals)
  const mintTx = await mockPusdc.mint(deployer.address, mintAmount);
  await mintTx.wait();
  console.log(`  Minted ${mintAmount} to deployer: ${mintTx.hash}`);

  // Step 3: Set operator
  console.log("\n  Step 3: Set operator...");
  const maxExpiry = (1n << 48n) - 1n;
  const isOp = await mockPusdc.isOperator(deployer.address, distributorAddr);
  if (!isOp) {
    const opTx = await mockPusdc.connect(deployer).setOperator(distributorAddr, maxExpiry);
    await opTx.wait();
    console.log(`  Operator set: ${opTx.hash}`);
  } else {
    console.log(`  Already an operator`);
  }

  // Step 4: Encrypt and call startDistribution
  console.log("\n  Step 4: Start distribution...");
  const cofheClient = await createCofheClient(hre, deployer);
  const yieldAmount = 1_000_000n; // 1 PUSDC
  const [encryptedYield] = await cofheClient
    .encryptInputs([Encryptable.uint64(yieldAmount)])
    .execute();

  try {
    const distTx = await distributor[
      "startDistribution((uint256,uint8,uint8,bytes))"
    ](encryptedYield, { gasLimit: 2_000_000 });
    const receipt = await distTx.wait();
    console.log(`  SUCCESS! tx: ${distTx.hash}`);
    console.log(`  gas used: ${receipt?.gasUsed}`);
    console.log("\n  TRACK A RESULT: PASS");
    console.log("  => Cross-contract confidentialTransferFrom works WITHOUT FHE.isAllowed check.");
  } catch (err: any) {
    const hash = err?.transaction?.hash ?? err?.receipt?.hash;
    console.log(`  FAILED! ${err.shortMessage ?? err.message}`);
    if (hash) console.log(`  tx: ${hash}`);
    if (err.data) console.log(`  revert data: ${err.data}`);
    console.log("\n  TRACK A RESULT: FAIL");
    console.log("  => Issue is NOT the ACL check. Problem is in FHE ops or contract interaction.");
  }

  // Step 5: Restore original PUSDC
  console.log("\n  Restoring original PUSDC...");
  if (currentPusdc.toLowerCase() !== mockPusdcAddr.toLowerCase()) {
    const restoreTx = await distributor.setPusdc(currentPusdc);
    await restoreTx.wait();
    console.log(`  Restored: ${restoreTx.hash}`);
  }
}

// ── Track B: TestFHERC20 (with ACL toggle) ────────────────────────────────

async function runTrackB() {
  console.log("\n" + "=".repeat(60));
  console.log("  TRACK B: TestFHERC20 (with FHE.isAllowed check)");
  console.log("=".repeat(60));

  // Load diagnostic deployment
  const diagPath = join(
    __dirname,
    "..",
    "deployments",
    `${network.name}.diagnostic.json`,
  );
  if (!existsSync(diagPath)) {
    console.log("  SKIP: No diagnostic deployment found.");
    console.log("  Run 'pnpm hardhat run scripts/deploy-diagnostic.ts --network arb-sepolia' first.");
    return;
  }

  const diag = JSON.parse(readFileSync(diagPath, "utf8"));
  const testTokenAddr = diag.contracts?.TestFHERC20;
  if (!testTokenAddr) {
    console.log("  SKIP: TestFHERC20 not found in diagnostic deployment.");
    return;
  }

  const [deployer] = await ethers.getSigners();
  const deployment = loadDeployment();
  const distributorAddr = getAddress(deployment, "YieldDistributor");
  const registryAddr = getAddress(deployment, "InvestorRegistry");

  console.log(`  TestFHERC20:      ${testTokenAddr}`);
  console.log(`  YieldDistributor: ${distributorAddr}`);
  console.log(`  Deployer:         ${deployer.address}\n`);

  const distributor = await ethers.getContractAt("YieldDistributor", distributorAddr);
  const testToken = await ethers.getContractAt("TestFHERC20", testTokenAddr);
  const registry = await ethers.getContractAt("InvestorRegistry", registryAddr);

  const investorCount = await registry.investorCount();
  if (investorCount === 0n) {
    console.log("  SKIP: No investors registered.");
    return;
  }

  const currentPusdc = await distributor.pusdc();
  const cofheClient = await createCofheClient(hre, deployer);
  const yieldAmount = 1_000_000n;
  const maxExpiry = (1n << 48n) - 1n;

  // Test with ACL check DISABLED first
  for (const aclEnabled of [false, true]) {
    const label = aclEnabled ? "ACL ON" : "ACL OFF";
    console.log(`\n  --- Test with ${label} ---`);

    // Toggle ACL check
    const toggleTx = await testToken.setAclCheckEnabled(aclEnabled);
    await toggleTx.wait();
    console.log(`  ACL check set to: ${aclEnabled}`);

    // Point distributor at TestFHERC20
    const switchTx = await distributor.setPusdc(testTokenAddr);
    await switchTx.wait();

    // Mint tokens
    const mintTx = await testToken.mint(deployer.address, yieldAmount * 2n);
    await mintTx.wait();

    // Set operator
    const isOp = await testToken.isOperator(deployer.address, distributorAddr);
    if (!isOp) {
      const opTx = await testToken.connect(deployer).setOperator(distributorAddr, maxExpiry);
      await opTx.wait();
    }

    // Encrypt and call startDistribution
    const [encYield] = await cofheClient
      .encryptInputs([Encryptable.uint64(yieldAmount)])
      .execute();

    try {
      const distTx = await distributor[
        "startDistribution((uint256,uint8,uint8,bytes))"
      ](encYield, { gasLimit: 2_000_000 });
      const receipt = await distTx.wait();
      console.log(`  PASS (${label}) tx: ${distTx.hash}, gas: ${receipt?.gasUsed}`);
    } catch (err: any) {
      const hash = err?.transaction?.hash ?? err?.receipt?.hash;
      console.log(`  FAIL (${label}) ${err.shortMessage ?? err.message}`);
      if (hash) console.log(`  tx: ${hash}`);
      if (err.data && err.data !== "0x") console.log(`  revert data: ${err.data}`);
    }
  }

  // Restore original PUSDC
  console.log("\n  Restoring original PUSDC...");
  const restoreTx = await distributor.setPusdc(currentPusdc);
  await restoreTx.wait();
  console.log(`  Restored`);

  console.log("\n  TRACK B Summary:");
  console.log("  If ACL OFF passed but ACL ON failed => FHE.isAllowed is the issue");
  console.log("  If both failed => FHE ops or contract interaction issue");
  console.log("  If both passed => Our original YieldDistributor code has a different issue");
}

// ── Error decoder ��────────────────────────────────────────────────────────

function tryDecodeError(data: string) {
  const knownErrors: Record<string, string> = {
    // FHERC20 errors
    "0x6b836e9b": "FHERC20UnauthorizedUseOfEncryptedAmount(bytes32,address)",
    "0xb4aefc83": "FHERC20UnauthorizedSpender(address,address)",
    "0x96c6fd1e": "FHERC20InvalidReceiver(address)",
    "0xe04d4f97": "FHERC20InvalidSender(address)",
    "0xf2e7e80d": "FHERC20ZeroBalance(address)",
    "0x2c7ec2e5": "FHERC20IncompatibleFunction()",
    // MockPUSDC errors
    "0x8a35aede": "NotOperator()",
    "0xf28dceb3": "NoBalance()",
  };

  const selector = data.slice(0, 10);
  const errorName = knownErrors[selector];
  if (errorName) {
    console.log(`          decoded: ${errorName}`);
  }
}

// ── Main ──────────────��───────────────────────────────────────────────────

async function main() {
  console.log(`\n${"=".repeat(60)}`);
  console.log("  PUSDC confidentialTransferFrom — Diagnostic Suite");
  console.log(`${"=".repeat(60)}`);
  console.log(`  Network:  ${network.name}`);
  console.log(`  PUSDC:    ${PUSDC_ADDRESS}`);

  // Track C always runs (no deployment needed)
  await runTrackC();

  // Tracks A and B require diagnostic deployment + YieldDistributor upgrade
  const diagPath = join(
    __dirname,
    "..",
    "deployments",
    `${network.name}.diagnostic.json`,
  );
  if (existsSync(diagPath)) {
    await runTrackA();
    await runTrackB();
  } else {
    console.log("\n--- Tracks A & B skipped (no diagnostic deployment) ---");
    console.log("Run deploy-diagnostic.ts first, then re-run this script.");
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("  Diagnostic complete");
  console.log(`${"=".repeat(60)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
