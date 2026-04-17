/**
 * Shared test fixtures and helpers for MuHaven Phase 8 tests.
 *
 * SDK pattern:
 *   - Client:    hre.cofhe.createClientWithBatteries(signer)
 *   - Encrypt:   client.encryptInputs([Encryptable.uint128(n)]).execute()
 *   - Mock read: hre.cofhe.mocks.getPlaintext(ctHash)
 *               hre.cofhe.mocks.expectPlaintext(ctHash, expectedValue)
 *   - On-chain decrypt (requestBalanceDecrypt / getBalanceDecryptResult):
 *               await time.increase(11) is required between request and read
 *               because MockTaskManager adds a 1–10 second timestamp delay.
 */

import hre from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { upgrades } from "hardhat";

const TASK_COFHE_MOCKS_DEPLOY = "task:cofhe-mocks:deploy";

// ── Addresses ────────────────────────────────────────────────────────────────

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ── ERC-20 mock amounts ───────────────────────────────────────────────────────

export const ONE_TOKEN = 1_000_000_000_000_000_000n; // 1e18

// ── Deploy helpers ────────────────────────────────────────────────────────────

export async function deployKYCAdapter() {
  const [deployer] = await hre.ethers.getSigners();
  const KYC = await hre.ethers.getContractFactory("ERC3643KYCAdapter");
  const kyc = await KYC.deploy(deployer.address);
  return kyc;
}

export async function deployRegistry() {
  const [deployer] = await hre.ethers.getSigners();
  const Registry = await hre.ethers.getContractFactory("InvestorRegistry");
  const registry = await upgrades.deployProxy(Registry, [deployer.address], {
    kind: "transparent",
    initializer: "initialize",
  });
  return registry;
}

export async function deployToken(kycAddress: string, registryAddress: string, issuerAddress: string) {
  const Token = await hre.ethers.getContractFactory("MuHavenToken");
  const token = await upgrades.deployProxy(
    Token,
    ["MuHaven RWA", "MHRWA", kycAddress, registryAddress, issuerAddress, ZERO_ADDRESS],
    { kind: "transparent", initializer: "initialize" }
  );
  return token;
}

export async function deployVault(underlyingAddress: string, tokenAddress: string, minInvestment: bigint) {
  const Vault = await hre.ethers.getContractFactory("MuHavenVault");
  const vault = await upgrades.deployProxy(
    Vault,
    [underlyingAddress, tokenAddress, minInvestment],
    { kind: "transparent", initializer: "initialize" }
  );
  return vault;
}

export async function deployRiskParams() {
  const [deployer] = await hre.ethers.getSigners();
  const RiskParams = await hre.ethers.getContractFactory("RiskParams");
  const riskParams = await upgrades.deployProxy(RiskParams, [deployer.address], {
    kind: "transparent",
    initializer: "initialize",
  });
  return riskParams;
}

export async function deployTestTreasury(initialSupply: bigint) {
  const Treasury = await hre.ethers.getContractFactory("TestTreasury");
  const treasury = await Treasury.deploy("Test RWA", "TRWA", initialSupply);
  return treasury;
}

export async function deployMockMuHavenEscrow() {
  const Mock = await hre.ethers.getContractFactory("MockMuHavenEscrow");
  const mock = await Mock.deploy();
  return mock;
}

export async function deployMockPUSDC() {
  const Mock = await hre.ethers.getContractFactory("MockPUSDC");
  const mock = await Mock.deploy();
  return mock;
}

export async function deployMuHavenEscrow(ownerAddress: string, paymentTokenAddress: string) {
  const Escrow = await hre.ethers.getContractFactory("MuHavenEscrow");
  const escrow = await upgrades.deployProxy(
    Escrow,
    [ownerAddress, paymentTokenAddress],
    { kind: "transparent", initializer: "initialize" }
  );
  return escrow;
}

export async function deployYieldGate(tokenAddress: string, kycAddress: string) {
  const YieldGate = await hre.ethers.getContractFactory("YieldGate");
  const gate = await YieldGate.deploy(tokenAddress, kycAddress);
  return gate;
}

export async function deployYieldDistributor(
  registryAddress: string,
  escrowAddress: string,
  yieldGateAddress: string,
  ownerAddress: string,
  pusdcAddress: string
) {
  const Factory = await hre.ethers.getContractFactory("YieldDistributor");
  const distributor = await upgrades.deployProxy(
    Factory,
    [registryAddress, escrowAddress, yieldGateAddress, ownerAddress, pusdcAddress],
    { kind: "transparent", initializer: "initialize" }
  );
  return distributor;
}

export async function deployTestEscrowFunder() {
  const Factory = await hre.ethers.getContractFactory("TestEscrowFunder");
  const funder = await Factory.deploy();
  return funder;
}

export async function deployTestCanRedeemChecker() {
  const Factory = await hre.ethers.getContractFactory("TestCanRedeemChecker");
  const checker = await Factory.deploy();
  return checker;
}

// ── Full system fixture ───────────────────────────────────────────────────────

/**
 * Deploys the full MuHaven contract suite wired together.
 * Whitelists `investor` in the KYC adapter.
 * Grants vault minter role on token.
 */
export async function deployMuHavenFixture() {
  await hre.run(TASK_COFHE_MOCKS_DEPLOY);

  const [deployer, issuer, investor, alice] = await hre.ethers.getSigners();

  // KYC adapter
  const kyc = await deployKYCAdapter();
  await kyc.addToWhitelist(investor.address);
  await kyc.addToWhitelist(alice.address);

  // Registry
  const registry = await deployRegistry();

  // Token
  const token = await deployToken(
    await kyc.getAddress(),
    await registry.getAddress(),
    issuer.address
  );

  // Wire: registry authorizes token to call register()
  await registry.setAuthorizedCaller(await token.getAddress(), true);

  // TestTreasury (mock ERC-20 underlying)
  const treasury = await deployTestTreasury(1_000_000n * ONE_TOKEN);

  // Vault — no min investment for most tests
  const vault = await deployVault(
    await treasury.getAddress(),
    await token.getAddress(),
    0n
  );

  // Wire: vault is a minter on the token
  await token.grantMinter(await vault.getAddress());

  // CoFHE client for deployer
  const client = await hre.cofhe.createClientWithBatteries(deployer);

  return { deployer, issuer, investor, alice, kyc, registry, token, vault, treasury, client };
}

// ── Escrow fixture ────────────────────────────────────────────────────────────

/**
 * Deploys the full escrow pipeline on top of the MuHaven fixture:
 *   MuHavenEscrow + YieldGate + MockPUSDC + TestEscrowFunder.
 *
 * Wiring:
 *   - yieldGate.authorizedEscrow = muhavenEscrow
 *   - muhavenEscrow.paymentToken = pusdc
 *   - muhavenEscrow.authorizedCallers[deployer] = true (for direct batchCreate tests)
 *   - muhavenEscrow.authorizedCallers[funder] = true (for fundFrom tests)
 *
 * Investor is registered via a mint of `ONE_TOKEN` from the issuer (KYC-gated),
 * so YieldGate.canRedeem(investor) is satisfiable out of the box.
 */
export async function deployEscrowFixture() {
  const base = await deployMuHavenFixture();
  const { deployer, issuer, investor, token, kyc } = base;

  // Mint tokens to investor so YieldGate's balance-init check passes
  const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
  const [encMint] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
  await token.connect(issuer).mint(investor.address, encMint);

  const pusdc = await deployMockPUSDC();
  const yieldGate = await deployYieldGate(
    await token.getAddress(),
    await kyc.getAddress()
  );
  const escrow = await deployMuHavenEscrow(deployer.address, await pusdc.getAddress());
  const funder = await deployTestEscrowFunder();

  // Wire everything
  await yieldGate.setAuthorizedEscrow(await escrow.getAddress());
  await escrow.setAuthorizedCaller(deployer.address, true);
  await escrow.setAuthorizedCaller(await funder.getAddress(), true);

  return { ...base, pusdc, yieldGate, escrow, funder };
}

// ── Time helpers ──────────────────────────────────────────────────────────────

/**
 * Advance block time past MockTaskManager's async decrypt delay (1–10 s).
 * Call this between requestBalanceDecrypt() and getBalanceDecryptResult().
 */
export async function waitForDecrypt() {
  await time.increase(11);
}

// ── Encryption helpers ────────────────────────────────────────────────────────

export { Encryptable };
