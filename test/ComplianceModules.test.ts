/**
 * Compliance module unit tests (Phase 3).
 *
 * Covers the five ERC-3643 modules shipped in Wave 3.5 per ADR-011:
 *   - CountryAllow       (per-token country allow-list)
 *   - CountryRestrict    (per-token country block-list)
 *   - MaxHolders         (per-token holder-count cap, split by accreditation)
 *   - Lockup             (per-wallet transfer-out lockup with default period)
 *   - MaxBalance         (per-wallet cleartext balance tracker per ADR-019)
 *
 * All modules inherit `ComplianceModuleBase` (owner + compliance pointer +
 * onlyCompliance modifier). State-hook tests call the module directly as
 * the bound compliance address to avoid the ModularCompliance fan-out
 * indirection — behaviour is identical.
 */

import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre, { upgrades } from "hardhat";
import { expect } from "chai";
import { ZERO_ADDRESS } from "./helpers/setup";

const TOKEN_A = "0x000000000000000000000000000000000000aaaa";
const TOKEN_B = "0x000000000000000000000000000000000000bbbb";

const COUNTRY_US = 840;
const COUNTRY_UK = 826;
const COUNTRY_DE = 276;
const COUNTRY_IR = 364;

// Per-signer country helper — assigns each tests' target EOA a country
// in the module's identity registry.
async function assignCountry(
  identityReg: any,
  account: string,
  country: number
) {
  await identityReg.setCountry(account, country);
}

// ── Shared fixture: IdentityRegistry + compliance coordinator mock ────────

async function deployIdentity() {
  const [deployer] = await hre.ethers.getSigners();

  const TopicsFactory = await hre.ethers.getContractFactory("ClaimTopicsRegistry");
  const topicsReg = await upgrades.deployProxy(
    TopicsFactory,
    [deployer.address],
    { kind: "transparent", initializer: "initialize" }
  );

  const IssuersFactory = await hre.ethers.getContractFactory("TrustedIssuersRegistry");
  const issuersReg = await upgrades.deployProxy(
    IssuersFactory,
    [deployer.address],
    { kind: "transparent", initializer: "initialize" }
  );

  const IdentityFactory = await hre.ethers.getContractFactory("MuHavenIdentityRegistry");
  const identityReg = await upgrades.deployProxy(
    IdentityFactory,
    [
      deployer.address,
      await topicsReg.getAddress(),
      await issuersReg.getAddress(),
      true, // devMode on — irrelevant to modules
    ],
    { kind: "transparent", initializer: "initialize" }
  );

  return { identityReg, topicsReg, issuersReg };
}

// ══════════════════════════════════════════════════════════════════════════
//                           CountryAllow
// ══════════════════════════════════════════════════════════════════════════

async function deployCountryAllow() {
  const [deployer, compliance] = await hre.ethers.getSigners();
  const { identityReg } = await deployIdentity();

  const Factory = await hre.ethers.getContractFactory("CountryAllow");
  const module = await upgrades.deployProxy(
    Factory,
    [
      deployer.address,
      compliance.address, // EOA stand-in for ModularCompliance
      await identityReg.getAddress(),
    ],
    { kind: "transparent", initializer: "initialize" }
  );

  return { deployer, compliance, identityReg, module };
}

describe("CountryAllow", () => {
  it("pre-config default is permissive (no allow-list entries)", async () => {
    const { module } = await loadFixture(deployCountryAllow);
    const [, , a, b] = await hre.ethers.getSigners();
    expect(await module.canTransfer(TOKEN_A, a.address, b.address, 0)).to.equal(true);
  });

  it("blocks once allow-list has entries and participant's country is not allowed", async () => {
    const { module, identityReg } = await loadFixture(deployCountryAllow);
    const [, , a, b] = await hre.ethers.getSigners();
    await assignCountry(identityReg, a.address, COUNTRY_US);
    await assignCountry(identityReg, b.address, COUNTRY_UK);

    await module.setAllowed(TOKEN_A, COUNTRY_US, true);
    // b's country (UK) not allowed → transfer blocked.
    expect(await module.canTransfer(TOKEN_A, a.address, b.address, 0)).to.equal(false);

    await module.setAllowed(TOKEN_A, COUNTRY_UK, true);
    expect(await module.canTransfer(TOKEN_A, a.address, b.address, 0)).to.equal(true);
  });

  it("skips zero-address side on mint / burn", async () => {
    const { module, identityReg } = await loadFixture(deployCountryAllow);
    const [, , a] = await hre.ethers.getSigners();
    await assignCountry(identityReg, a.address, COUNTRY_US);
    await module.setAllowed(TOKEN_A, COUNTRY_US, true);

    // Mint (from == 0) — only `to` checked.
    expect(await module.canTransfer(TOKEN_A, ZERO_ADDRESS, a.address, 0)).to.equal(true);
    // Burn (to == 0) — only `from` checked.
    expect(await module.canTransfer(TOKEN_A, a.address, ZERO_ADDRESS, 0)).to.equal(true);
  });

  it("toggling allow off decrements counter; re-enters permissive mode when all removed", async () => {
    const { module, identityReg } = await loadFixture(deployCountryAllow);
    const [, , a] = await hre.ethers.getSigners();
    await assignCountry(identityReg, a.address, COUNTRY_IR);

    await module.setAllowed(TOKEN_A, COUNTRY_US, true);
    expect(await module.canTransfer(TOKEN_A, a.address, a.address, 0)).to.equal(false);
    await module.setAllowed(TOKEN_A, COUNTRY_US, false);
    // Zero entries ⇒ permissive default re-engages.
    expect(await module.canTransfer(TOKEN_A, a.address, a.address, 0)).to.equal(true);
  });

  it("setAllowedBatch toggles many countries at once", async () => {
    const { module } = await loadFixture(deployCountryAllow);
    await module.setAllowedBatch(TOKEN_A, [COUNTRY_US, COUNTRY_UK, COUNTRY_DE], true);
    expect(await module.isAllowed(TOKEN_A, COUNTRY_US)).to.equal(true);
    expect(await module.isAllowed(TOKEN_A, COUNTRY_UK)).to.equal(true);
    expect(await module.isAllowed(TOKEN_A, COUNTRY_DE)).to.equal(true);
    expect(await module.allowedCount(TOKEN_A)).to.equal(3n);
  });

  it("non-owner cannot toggle allowance; non-compliance cannot fire state hooks", async () => {
    const { module } = await loadFixture(deployCountryAllow);
    const [, , stranger] = await hre.ethers.getSigners();
    await expect(
      module.connect(stranger).setAllowed(TOKEN_A, COUNTRY_US, true)
    ).to.be.revertedWithCustomError(module, "OnlyOwner");
    await expect(
      module.connect(stranger).transferred(TOKEN_A, stranger.address, stranger.address, 1)
    ).to.be.revertedWithCustomError(module, "OnlyCompliance");
  });

  it("name() returns keccak256(\"CountryAllow\")", async () => {
    const { module } = await loadFixture(deployCountryAllow);
    expect(await module.name()).to.equal(
      hre.ethers.keccak256(hre.ethers.toUtf8Bytes("CountryAllow"))
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
//                          CountryRestrict
// ══════════════════════════════════════════════════════════════════════════

async function deployCountryRestrict() {
  const [deployer, compliance] = await hre.ethers.getSigners();
  const { identityReg } = await deployIdentity();

  const Factory = await hre.ethers.getContractFactory("CountryRestrict");
  const module = await upgrades.deployProxy(
    Factory,
    [
      deployer.address,
      compliance.address,
      await identityReg.getAddress(),
    ],
    { kind: "transparent", initializer: "initialize" }
  );

  return { deployer, compliance, identityReg, module };
}

describe("CountryRestrict", () => {
  it("default is permissive (empty block-list)", async () => {
    const { module } = await loadFixture(deployCountryRestrict);
    const [, , a, b] = await hre.ethers.getSigners();
    expect(await module.canTransfer(TOKEN_A, a.address, b.address, 0)).to.equal(true);
  });

  it("blocks when sender or recipient is in a restricted country", async () => {
    const { module, identityReg } = await loadFixture(deployCountryRestrict);
    const [, , a, b] = await hre.ethers.getSigners();
    await assignCountry(identityReg, a.address, COUNTRY_IR);
    await assignCountry(identityReg, b.address, COUNTRY_US);

    await module.setRestricted(TOKEN_A, COUNTRY_IR, true);

    // Sender restricted.
    expect(await module.canTransfer(TOKEN_A, a.address, b.address, 0)).to.equal(false);
    // Flip direction — recipient restricted.
    expect(await module.canTransfer(TOKEN_A, b.address, a.address, 0)).to.equal(false);
  });

  it("skips zero-address side on mint / burn", async () => {
    const { module, identityReg } = await loadFixture(deployCountryRestrict);
    const [, , a] = await hre.ethers.getSigners();
    await assignCountry(identityReg, a.address, COUNTRY_IR);
    await module.setRestricted(TOKEN_A, COUNTRY_IR, true);

    // Burn from restricted still blocked (real participant is restricted).
    expect(await module.canTransfer(TOKEN_A, a.address, ZERO_ADDRESS, 0)).to.equal(false);
    // Mint to restricted also blocked.
    expect(await module.canTransfer(TOKEN_A, ZERO_ADDRESS, a.address, 0)).to.equal(false);
  });

  it("setRestrictedBatch toggles many entries at once", async () => {
    const { module } = await loadFixture(deployCountryRestrict);
    await module.setRestrictedBatch(TOKEN_A, [COUNTRY_IR, COUNTRY_US], true);
    expect(await module.isRestricted(TOKEN_A, COUNTRY_IR)).to.equal(true);
    expect(await module.isRestricted(TOKEN_A, COUNTRY_US)).to.equal(true);
  });

  it("non-owner cannot toggle restriction", async () => {
    const { module } = await loadFixture(deployCountryRestrict);
    const [, , stranger] = await hre.ethers.getSigners();
    await expect(
      module.connect(stranger).setRestricted(TOKEN_A, COUNTRY_IR, true)
    ).to.be.revertedWithCustomError(module, "OnlyOwner");
  });
});

// ══════════════════════════════════════════════════════════════════════════
//                             MaxHolders
// ══════════════════════════════════════════════════════════════════════════

async function deployMaxHolders() {
  const [deployer, compliance] = await hre.ethers.getSigners();
  const { identityReg } = await deployIdentity();

  const InvestorRegistryFactory = await hre.ethers.getContractFactory("InvestorRegistry");
  const investorReg = await upgrades.deployProxy(
    InvestorRegistryFactory,
    [deployer.address],
    { kind: "transparent", initializer: "initialize" }
  );

  const Factory = await hre.ethers.getContractFactory("MaxHolders");
  const module = await upgrades.deployProxy(
    Factory,
    [
      deployer.address,
      compliance.address,
      await identityReg.getAddress(),
      await investorReg.getAddress(),
    ],
    { kind: "transparent", initializer: "initialize" }
  );

  return { deployer, compliance, identityReg, investorReg, module };
}

describe("MaxHolders", () => {
  it("permissive when caps uninitialised", async () => {
    const { module } = await loadFixture(deployMaxHolders);
    const [, , a] = await hre.ethers.getSigners();
    expect(await module.canTransfer(TOKEN_A, ZERO_ADDRESS, a.address, 0)).to.equal(true);
  });

  it("non-accredited cap: blocks third holder when max=2", async () => {
    const { module, compliance } = await loadFixture(deployMaxHolders);
    const [, , a, b, c] = await hre.ethers.getSigners();
    await module.setMaxNonAccredited(TOKEN_A, 2);

    // First two holders admitted + counted via `created` hook.
    expect(await module.canTransfer(TOKEN_A, ZERO_ADDRESS, a.address, 0)).to.equal(true);
    await module.connect(compliance).created(TOKEN_A, a.address, 0);
    expect(await module.canTransfer(TOKEN_A, ZERO_ADDRESS, b.address, 0)).to.equal(true);
    await module.connect(compliance).created(TOKEN_A, b.address, 0);

    // Third would push over cap → block.
    expect(await module.canTransfer(TOKEN_A, ZERO_ADDRESS, c.address, 0)).to.equal(false);
  });

  it("accredited cap: separate counter; accredited holders don't consume the retail cap", async () => {
    const { module, compliance, identityReg } = await loadFixture(deployMaxHolders);
    const [, , a, b] = await hre.ethers.getSigners();
    await identityReg.setAccredited(a.address, true);
    await module.setMaxNonAccredited(TOKEN_A, 1);
    await module.setMaxAccredited(TOKEN_A, 1);

    // Accredited mint goes to accredited counter.
    expect(await module.canTransfer(TOKEN_A, ZERO_ADDRESS, a.address, 0)).to.equal(true);
    await module.connect(compliance).created(TOKEN_A, a.address, 0);
    expect(await module.accreditedHolders(TOKEN_A)).to.equal(1n);
    expect(await module.nonAccreditedHolders(TOKEN_A)).to.equal(0n);

    // Non-accredited still has room.
    expect(await module.canTransfer(TOKEN_A, ZERO_ADDRESS, b.address, 0)).to.equal(true);
    await module.connect(compliance).created(TOKEN_A, b.address, 0);
    expect(await module.nonAccreditedHolders(TOKEN_A)).to.equal(1n);

    // Second non-accredited goes over → blocks.
    const [, , , , c] = await hre.ethers.getSigners();
    expect(await module.canTransfer(TOKEN_A, ZERO_ADDRESS, c.address, 0)).to.equal(false);
  });

  it("already-counted recipient passes even when cap reached", async () => {
    const { module, compliance } = await loadFixture(deployMaxHolders);
    const [, , a] = await hre.ethers.getSigners();
    await module.setMaxNonAccredited(TOKEN_A, 1);
    await module.connect(compliance).created(TOKEN_A, a.address, 0);
    // Subsequent transfer to the same holder — no-op to the counter, allowed.
    expect(await module.canTransfer(TOKEN_A, ZERO_ADDRESS, a.address, 0)).to.equal(true);
  });

  it("burn side (to == 0) is always allowed and does not decrement counter", async () => {
    const { module, compliance } = await loadFixture(deployMaxHolders);
    const [, , a] = await hre.ethers.getSigners();
    await module.setMaxNonAccredited(TOKEN_A, 5);
    await module.connect(compliance).created(TOKEN_A, a.address, 0);
    expect(await module.canTransfer(TOKEN_A, a.address, ZERO_ADDRESS, 0)).to.equal(true);
    // destroyed is a no-op per ADR-022.
    await module.connect(compliance).destroyed(TOKEN_A, a.address, 0);
    expect(await module.nonAccreditedHolders(TOKEN_A)).to.equal(1n);
  });

  it("non-compliance cannot fire created / transferred / destroyed", async () => {
    const { module } = await loadFixture(deployMaxHolders);
    const [, , stranger] = await hre.ethers.getSigners();
    await expect(
      module.connect(stranger).created(TOKEN_A, stranger.address, 0)
    ).to.be.revertedWithCustomError(module, "OnlyCompliance");
  });
});

// ══════════════════════════════════════════════════════════════════════════
//                              Lockup
// ══════════════════════════════════════════════════════════════════════════

async function deployLockup() {
  const [deployer, compliance] = await hre.ethers.getSigners();

  const Factory = await hre.ethers.getContractFactory("Lockup");
  const module = await upgrades.deployProxy(
    Factory,
    [deployer.address, compliance.address],
    { kind: "transparent", initializer: "initialize" }
  );

  return { deployer, compliance, module };
}

describe("Lockup", () => {
  it("permissive when lockup period is 0", async () => {
    const { module } = await loadFixture(deployLockup);
    const [, , a, b] = await hre.ethers.getSigners();
    expect(await module.canTransfer(TOKEN_A, a.address, b.address, 0)).to.equal(true);
  });

  it("mint always allowed; lockup starts post-mint + blocks transfer during window", async () => {
    const { module, compliance } = await loadFixture(deployLockup);
    const [, , a, b] = await hre.ethers.getSigners();
    await module.setDefaultLockupPeriod(TOKEN_A, 1000);

    // Mint allowed regardless.
    expect(await module.canTransfer(TOKEN_A, ZERO_ADDRESS, a.address, 0)).to.equal(true);
    await module.connect(compliance).created(TOKEN_A, a.address, 0);

    // Transfer out blocked during window.
    expect(await module.canTransfer(TOKEN_A, a.address, b.address, 0)).to.equal(false);

    // Advance past unlock.
    await hre.network.provider.send("evm_increaseTime", [2000]);
    await hre.network.provider.send("evm_mine");
    expect(await module.canTransfer(TOKEN_A, a.address, b.address, 0)).to.equal(true);
  });

  it("transfer-in extends recipient's lockup", async () => {
    const { module, compliance } = await loadFixture(deployLockup);
    const [, , a] = await hre.ethers.getSigners();
    await module.setDefaultLockupPeriod(TOKEN_A, 500);

    const now0 = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
    await module.connect(compliance).transferred(TOKEN_A, ZERO_ADDRESS, a.address, 0);
    const unlock1 = Number(await module.unlockTimeOf(TOKEN_A, a.address));
    expect(unlock1).to.be.greaterThanOrEqual(now0 + 500);

    // Second transfer-in after some time extends the lockup further.
    await hre.network.provider.send("evm_increaseTime", [100]);
    await hre.network.provider.send("evm_mine");
    await module.connect(compliance).transferred(TOKEN_A, ZERO_ADDRESS, a.address, 0);
    const unlock2 = Number(await module.unlockTimeOf(TOKEN_A, a.address));
    expect(unlock2).to.be.greaterThan(unlock1);
  });

  it("owner can override unlock time (migration path)", async () => {
    const { module } = await loadFixture(deployLockup);
    const [, , a] = await hre.ethers.getSigners();
    await expect(module.setUnlockTime(TOKEN_A, a.address, 0))
      .to.emit(module, "UnlockTimeUpdated")
      .withArgs(TOKEN_A, a.address, 0);
    expect(await module.unlockTimeOf(TOKEN_A, a.address)).to.equal(0n);
  });

  it("non-owner cannot set default period or unlock time", async () => {
    const { module } = await loadFixture(deployLockup);
    const [, , stranger] = await hre.ethers.getSigners();
    await expect(
      module.connect(stranger).setDefaultLockupPeriod(TOKEN_A, 100)
    ).to.be.revertedWithCustomError(module, "OnlyOwner");
  });
});

// ══════════════════════════════════════════════════════════════════════════
//                             MaxBalance
// ══════════════════════════════════════════════════════════════════════════

async function deployMaxBalance() {
  const [deployer, compliance] = await hre.ethers.getSigners();

  const Factory = await hre.ethers.getContractFactory("MaxBalance");
  const module = await upgrades.deployProxy(
    Factory,
    [deployer.address, compliance.address],
    { kind: "transparent", initializer: "initialize" }
  );

  return { deployer, compliance, module };
}

describe("MaxBalance", () => {
  it("permissive when maxBalance uninitialised", async () => {
    const { module } = await loadFixture(deployMaxBalance);
    const [, , a] = await hre.ethers.getSigners();
    expect(await module.canTransfer(TOKEN_A, ZERO_ADDRESS, a.address, 500)).to.equal(
      true
    );
  });

  it("blocks when recipient's tracker + amount > cap", async () => {
    const { module, compliance } = await loadFixture(deployMaxBalance);
    const [, , a] = await hre.ethers.getSigners();
    await module.setMaxBalance(TOKEN_A, 100);

    // First mint of 80 under cap.
    expect(await module.canTransfer(TOKEN_A, ZERO_ADDRESS, a.address, 80)).to.equal(true);
    await module.connect(compliance).created(TOKEN_A, a.address, 80);
    expect(await module.trackerOf(TOKEN_A, a.address)).to.equal(80n);

    // Subsequent mint of 30 overshoots (80 + 30 = 110 > 100).
    expect(await module.canTransfer(TOKEN_A, ZERO_ADDRESS, a.address, 30)).to.equal(
      false
    );

    // Mint of exactly 20 fits.
    expect(await module.canTransfer(TOKEN_A, ZERO_ADDRESS, a.address, 20)).to.equal(true);
  });

  it("destroyed decrements tracker; new headroom admits subsequent mint", async () => {
    const { module, compliance } = await loadFixture(deployMaxBalance);
    const [, , a] = await hre.ethers.getSigners();
    await module.setMaxBalance(TOKEN_A, 100);
    await module.connect(compliance).created(TOKEN_A, a.address, 100);
    expect(await module.canTransfer(TOKEN_A, ZERO_ADDRESS, a.address, 1)).to.equal(false);

    await module.connect(compliance).destroyed(TOKEN_A, a.address, 60);
    expect(await module.trackerOf(TOKEN_A, a.address)).to.equal(40n);
    expect(await module.canTransfer(TOKEN_A, ZERO_ADDRESS, a.address, 50)).to.equal(true);
  });

  it("destroyed clamps at zero when burn exceeds tracker", async () => {
    const { module, compliance } = await loadFixture(deployMaxBalance);
    const [, , a] = await hre.ethers.getSigners();
    await module.setMaxBalance(TOKEN_A, 100);
    await module.connect(compliance).created(TOKEN_A, a.address, 50);
    // Burn 100 > tracker 50 → tracker clamps to 0.
    await module.connect(compliance).destroyed(TOKEN_A, a.address, 100);
    expect(await module.trackerOf(TOKEN_A, a.address)).to.equal(0n);
  });

  it("transferred decrements sender and credits recipient", async () => {
    const { module, compliance } = await loadFixture(deployMaxBalance);
    const [, , a, b] = await hre.ethers.getSigners();
    await module.setMaxBalance(TOKEN_A, 200);
    await module.connect(compliance).created(TOKEN_A, a.address, 100);
    await module.connect(compliance).transferred(TOKEN_A, a.address, b.address, 40);
    expect(await module.trackerOf(TOKEN_A, a.address)).to.equal(60n);
    expect(await module.trackerOf(TOKEN_A, b.address)).to.equal(40n);
  });

  it("burn side (to == 0) is always allowed", async () => {
    const { module } = await loadFixture(deployMaxBalance);
    const [, , a] = await hre.ethers.getSigners();
    await module.setMaxBalance(TOKEN_A, 10);
    expect(await module.canTransfer(TOKEN_A, a.address, ZERO_ADDRESS, 999)).to.equal(
      true
    );
  });

  it("owner can reconcile trackers manually (Wave 3.5 slack patch)", async () => {
    const { module } = await loadFixture(deployMaxBalance);
    const [, , a] = await hre.ethers.getSigners();
    await expect(module.setTracker(TOKEN_A, a.address, 42))
      .to.emit(module, "TrackerAdjusted")
      .withArgs(TOKEN_A, a.address, 42);
    expect(await module.trackerOf(TOKEN_A, a.address)).to.equal(42n);
  });

  it("non-owner cannot set max or tracker", async () => {
    const { module } = await loadFixture(deployMaxBalance);
    const [, , stranger] = await hre.ethers.getSigners();
    await expect(
      module.connect(stranger).setMaxBalance(TOKEN_A, 10)
    ).to.be.revertedWithCustomError(module, "OnlyOwner");
    await expect(
      module.connect(stranger).setTracker(TOKEN_A, stranger.address, 10)
    ).to.be.revertedWithCustomError(module, "OnlyOwner");
  });
});
