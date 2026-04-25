/**
 * Wave 3.5 test harness + fixtures.
 *
 * Phase 1 scope: interface freeze + mocked full-stack fixture. Phase 2
 * implementation will extend this file as each contract lands (Subscription,
 * Treasury, Queue, YieldSnapshot, TokenRegistry, IdentityRegistry,
 * ModularCompliance).
 *
 * Design notes:
 *   - Contract unit tests use EOA stand-ins for investor + issuer (ADR-017
 *     sequential + Phase 1 M1 review: full kernel/UserOp flow is tested
 *     in SDK integration + Playwright, not in Hardhat).
 *   - `ephemeralEOA` per ADR-021 is just a random `ethers.Wallet` — tests
 *     never call `FHE.allow(handle, ephemeralEOA)` via a real permit; they
 *     use the CoFHE mock ACL which honours whatever address the contract
 *     grants. The helper here exists so test code mirrors the contract
 *     signatures cleanly without ad-hoc signer generation scattered around.
 *   - Mocks come from `contracts/mocks/` — `MockPUSDC` (legacy
 *     `euint64 = uint256` selector path per ADR-008) and `MockPriceOracle`
 *     (setter-driven stand-in for `IPriceOracle`).
 */

import hre, { upgrades } from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import {
  deployKYCAdapter,
  deployRegistry,
  deployToken,
  deployVault,
  deployMockPUSDC,
  ZERO_ADDRESS,
  ONE_TOKEN,
} from "./setup";

const TASK_COFHE_MOCKS_DEPLOY = "task:cofhe-mocks:deploy";

// ── Deploy helpers for the Wave 3.5-only mocks ────────────────────────────

export async function deployMockPriceOracle() {
  const Factory = await hre.ethers.getContractFactory("MockPriceOracle");
  const oracle = await Factory.deploy();
  return oracle;
}

// ── Ephemeral-EOA signer helper (ADR-021) ─────────────────────────────────

/**
 * Create a fresh ephemeral ECDSA keypair for a test. Mirrors the frontend
 * `useFhe.ts` behaviour (ADR-009 / ADR-021) where each session generates a
 * random in-memory signer that receives `FHE.allow` grants on every handle
 * the user decrypts.
 *
 * Returned wallet is unconnected — the address is all the contract needs.
 * When a test wants to verify the grant took effect, it can read the mock
 * ACL directly via `hre.cofhe.mocks.*` utilities.
 */
export function createEphemeralEOA() {
  return hre.ethers.Wallet.createRandom();
}

// ── Wave 3.5 mocked-stack fixture ─────────────────────────────────────────

/**
 * Deploys the Wave 3.5 "mocked stack" — everything that exists in Phase 1
 * plus the PUSDC mock + price-oracle mock, wired to an investor EOA.
 *
 * Phase 1 definition of done: this fixture compiles, deploys, and returns
 * every contract test code will need in Phase 2 + Phase 3. New Wave 3.5
 * contracts (`MuHavenSubscription`, `MuHavenTreasury`, `RedemptionQueue`,
 * `YieldSnapshot`, `TokenRegistry`, `IdentityRegistry`, `ModularCompliance`)
 * are added to this fixture as they land in Phase 2+.
 */
export async function deployV2Fixture() {
  await hre.run(TASK_COFHE_MOCKS_DEPLOY);

  const [deployer, issuer, investor, alice, bob] = await hre.ethers.getSigners();

  // Carry-over Wave 3 pieces (KYC, Registry, Token, Vault) — same as Wave 3
  // deploy shape. Wave 3.5 replaces the KYC adapter with IdentityRegistry in
  // Phase 3; for Phase 1 the legacy adapter still sits under the same slot so
  // the fixture can already deploy Token successfully.
  const kyc = await deployKYCAdapter();
  await kyc.addToWhitelist(investor.address);
  await kyc.addToWhitelist(alice.address);
  await kyc.addToWhitelist(bob.address);

  const registry = await deployRegistry();

  const token = await deployToken(
    await kyc.getAddress(),
    await registry.getAddress(),
    issuer.address
  );

  // Authorise the Token to register holders in the registry (matches Wave 3
  // wiring).
  await registry.setAuthorizedCaller(await token.getAddress(), true);

  const underlying = await (async () => {
    const Factory = await hre.ethers.getContractFactory("TestTreasury");
    return Factory.deploy("Underlying RWA", "URWA", 1_000_000n * ONE_TOKEN);
  })();
  const vault = await deployVault(
    await underlying.getAddress(),
    await token.getAddress(),
    0n
  );
  await token.grantMinter(await vault.getAddress());

  // Wave 3.5-specific mocks
  const pusdc = await deployMockPUSDC();
  const oracle = await deployMockPriceOracle();

  // Pin a NAV so any purchase flow test doesn't trip staleness. Uses a
  // round 1 PUSDC per share (1e6 in 6-decimal PUSDC base units) as a
  // sensible default; tests can override per-token.
  const now = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
  await oracle.setNAV(await token.getAddress(), 1_000_000n, BigInt(now));

  const client = await hre.cofhe.createClientWithBatteries(deployer);
  const investorClient = await hre.cofhe.createClientWithBatteries(investor);

  const ephemeralEOA = createEphemeralEOA();

  return {
    deployer,
    issuer,
    investor,
    alice,
    bob,
    kyc,
    registry,
    token,
    vault,
    underlying,
    pusdc,
    oracle,
    client,
    investorClient,
    ephemeralEOA,
  };
}

// ── Phase 7.5 — MuHavenStable wrapper fixture variant ────────────────────

/**
 * Wave 3.5 stack with `MuHavenStable` standing in for legacy PUSDC. Used by
 * the Phase 7.5-B regression cases to confirm silent-fail semantics survive
 * the wrapper rotation. Returns the same shape as `deployV2Fixture` plus
 * `mhUSDC`; the `pusdc` slot still points at the underlying legacy mock so
 * tests can seed wrap balances + assert the 1:1 invariant.
 *
 * Topology:
 *   - MockPUSDC  → underlying legacy confidential USDC.
 *   - mhUSDC     → MuHavenStable proxy backed by MockPUSDC.
 *   - investor pre-wraps `wrapAmount` PUSDC → mhUSDC so subsequent test
 *     flows have a starting mhUSDC balance to spend.
 *
 *   Subscription / Treasury / Queue / YieldSnapshot are NOT wired here —
 *   the regression suite below only covers the surface that Phase 7.5-A
 *   shipped. Phase 7.5-C will take a follow-up pass.
 */
export async function deployV2FixtureWithWrapper(wrapAmount: bigint = 100_000_000n) {
  const base = await deployV2Fixture();
  const { deployer, investor, pusdc } = base;

  const Stable = await hre.ethers.getContractFactory("MuHavenStable");
  const mhUSDC = await upgrades.deployProxy(
    Stable,
    [
      "MuHaven Confidential USD",
      "mhUSDC",
      deployer.address,
      await pusdc.getAddress(),
    ],
    { kind: "transparent", initializer: "initialize" }
  );

  // Pre-seed investor with PUSDC and wrap part of it into mhUSDC so the
  // regression cases can transact in mhUSDC immediately.
  await pusdc.mint(investor.address, wrapAmount * 2n);
  await pusdc
    .connect(investor)
    .setOperator(await mhUSDC.getAddress(), 2n ** 47n - 1n);

  const investorClient = await hre.cofhe.createClientWithBatteries(investor);
  const [encWrap] = await investorClient
    .encryptInputs([Encryptable.uint64(wrapAmount)])
    .execute();
  await mhUSDC
    .connect(investor)
    .wrap(encWrap, base.ephemeralEOA.address);

  return {
    ...base,
    mhUSDC,
  };
}

// ── Re-exports for convenience ────────────────────────────────────────────

export { Encryptable, ZERO_ADDRESS, ONE_TOKEN };
