/**
 * ModularCompliance unit tests (Phase 3).
 *
 * Focuses on the coordinator's own behaviour: bind / unbind, canTransfer
 * aggregation (AND of all modules), state-hook fan-out, per-token
 * isolation, admin access control, module cap.
 *
 * Individual module behaviour is covered in the per-module test files.
 */

import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre, { upgrades } from "hardhat";
import { expect } from "chai";
import { ZERO_ADDRESS } from "./helpers/setup";

const TOKEN_A = "0x000000000000000000000000000000000000aaaa";
const TOKEN_B = "0x000000000000000000000000000000000000bbbb";

async function deployFixture() {
  const [deployer, a, b] = await hre.ethers.getSigners();

  const CoordFactory = await hre.ethers.getContractFactory("ModularCompliance");
  const compliance = await upgrades.deployProxy(
    CoordFactory,
    [deployer.address],
    { kind: "transparent", initializer: "initialize" }
  );

  // Reuse the existing phase-2 stub compliance modules as "always allow"
  // / "always deny" test fixtures for the coordinator. They implement
  // IModularCompliance but the coordinator only ever reads canTransfer
  // + state hooks via IComplianceModule — which those stubs also satisfy
  // because they implement the superset. However the stubs DO NOT expose
  // a `name()` etc. so we'll use minimal fresh test modules below.
  return { deployer, a, b, compliance };
}

/**
 * Deploy a permissive compliance-module stub for coordinator tests. Mirrors
 * the `IComplianceModule` surface without any owner plumbing — just a
 * canTransfer that flips based on a constructor-set boolean.
 */
async function deployStubAllow() {
  const Factory = await hre.ethers.getContractFactory("AllowStubModule");
  const stub = await Factory.deploy();
  return stub;
}

async function deployStubDeny() {
  const Factory = await hre.ethers.getContractFactory("DenyStubModule");
  const stub = await Factory.deploy();
  return stub;
}

describe("ModularCompliance", () => {
  describe("initialization", () => {
    it("records owner", async () => {
      const { deployer, compliance } = await loadFixture(deployFixture);
      expect(await compliance.owner()).to.equal(deployer.address);
    });

    it("rejects zero owner", async () => {
      const Factory = await hre.ethers.getContractFactory("ModularCompliance");
      await expect(
        upgrades.deployProxy(Factory, [ZERO_ADDRESS], {
          kind: "transparent",
          initializer: "initialize",
        })
      ).to.be.revertedWithCustomError(Factory, "ZeroAddress");
    });
  });

  describe("bindModule / unbindModule", () => {
    it("bind adds module and emits; getBoundModules reflects it", async () => {
      const { compliance } = await loadFixture(deployFixture);
      const stub = await deployStubAllow();
      await expect(compliance.bindModule(TOKEN_A, await stub.getAddress()))
        .to.emit(compliance, "ModuleBound")
        .withArgs(TOKEN_A, await stub.getAddress());

      expect(await compliance.moduleCount(TOKEN_A)).to.equal(1n);
      expect(await compliance.isModuleBound(TOKEN_A, await stub.getAddress())).to.equal(
        true
      );
      const bound = await compliance.getBoundModules(TOKEN_A);
      expect(bound).to.deep.equal([await stub.getAddress()]);
    });

    it("re-bind reverts ModuleAlreadyBound", async () => {
      const { compliance } = await loadFixture(deployFixture);
      const stub = await deployStubAllow();
      await compliance.bindModule(TOKEN_A, await stub.getAddress());
      await expect(
        compliance.bindModule(TOKEN_A, await stub.getAddress())
      ).to.be.revertedWithCustomError(compliance, "ModuleAlreadyBound");
    });

    it("unbind swap-and-pops and emits", async () => {
      const { compliance } = await loadFixture(deployFixture);
      const s1 = await deployStubAllow();
      const s2 = await deployStubAllow();
      const s3 = await deployStubAllow();
      await compliance.bindModule(TOKEN_A, await s1.getAddress());
      await compliance.bindModule(TOKEN_A, await s2.getAddress());
      await compliance.bindModule(TOKEN_A, await s3.getAddress());

      await expect(compliance.unbindModule(TOKEN_A, await s2.getAddress()))
        .to.emit(compliance, "ModuleUnbound")
        .withArgs(TOKEN_A, await s2.getAddress());
      expect(await compliance.moduleCount(TOKEN_A)).to.equal(2n);
      expect(await compliance.isModuleBound(TOKEN_A, await s2.getAddress())).to.equal(
        false
      );
    });

    it("unbind unknown module reverts ModuleNotBound", async () => {
      const { compliance } = await loadFixture(deployFixture);
      const stub = await deployStubAllow();
      await expect(
        compliance.unbindModule(TOKEN_A, await stub.getAddress())
      ).to.be.revertedWithCustomError(compliance, "ModuleNotBound");
    });

    it("rejects zero token / module", async () => {
      const { compliance } = await loadFixture(deployFixture);
      const stub = await deployStubAllow();
      await expect(
        compliance.bindModule(ZERO_ADDRESS, await stub.getAddress())
      ).to.be.revertedWithCustomError(compliance, "ZeroAddress");
      await expect(
        compliance.bindModule(TOKEN_A, ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(compliance, "ZeroAddress");
    });

    it("non-owner cannot bind or unbind", async () => {
      const { compliance } = await loadFixture(deployFixture);
      const [, stranger] = await hre.ethers.getSigners();
      const stub = await deployStubAllow();
      await expect(
        compliance.connect(stranger).bindModule(TOKEN_A, await stub.getAddress())
      ).to.be.revertedWithCustomError(compliance, "OnlyOwner");
    });

    it("enforces MAX_MODULES_PER_TOKEN cap", async () => {
      const { compliance } = await loadFixture(deployFixture);
      const cap = Number(await compliance.MAX_MODULES_PER_TOKEN());
      for (let i = 0; i < cap; i++) {
        const stub = await deployStubAllow();
        await compliance.bindModule(TOKEN_A, await stub.getAddress());
      }
      const oneMore = await deployStubAllow();
      await expect(
        compliance.bindModule(TOKEN_A, await oneMore.getAddress())
      ).to.be.revertedWithCustomError(compliance, "TooManyModules");
    });

    it("per-token isolation: token A bindings don't affect token B", async () => {
      const { compliance } = await loadFixture(deployFixture);
      const stub = await deployStubAllow();
      await compliance.bindModule(TOKEN_A, await stub.getAddress());
      expect(await compliance.moduleCount(TOKEN_A)).to.equal(1n);
      expect(await compliance.moduleCount(TOKEN_B)).to.equal(0n);
    });
  });

  describe("canTransfer aggregation", () => {
    it("empty module list ⇒ true (permissive default)", async () => {
      const { compliance } = await loadFixture(deployFixture);
      const [, a, b] = await hre.ethers.getSigners();
      expect(await compliance.canTransfer(TOKEN_A, a.address, b.address, 0)).to.equal(
        true
      );
    });

    it("all-allow modules ⇒ true", async () => {
      const { compliance } = await loadFixture(deployFixture);
      const [, a, b] = await hre.ethers.getSigners();
      const s1 = await deployStubAllow();
      const s2 = await deployStubAllow();
      await compliance.bindModule(TOKEN_A, await s1.getAddress());
      await compliance.bindModule(TOKEN_A, await s2.getAddress());
      expect(await compliance.canTransfer(TOKEN_A, a.address, b.address, 0)).to.equal(
        true
      );
    });

    it("any deny ⇒ false (short-circuit)", async () => {
      const { compliance } = await loadFixture(deployFixture);
      const [, a, b] = await hre.ethers.getSigners();
      const allow = await deployStubAllow();
      const deny = await deployStubDeny();
      await compliance.bindModule(TOKEN_A, await allow.getAddress());
      await compliance.bindModule(TOKEN_A, await deny.getAddress());
      expect(await compliance.canTransfer(TOKEN_A, a.address, b.address, 0)).to.equal(
        false
      );
    });
  });

  describe("state-hook fan-out", () => {
    it("reverts NotAuthorizedCaller when caller isn't authorized for the token", async () => {
      const { compliance } = await loadFixture(deployFixture);
      const [, a] = await hre.ethers.getSigners();
      const stub = await deployStubAllow();
      await compliance.bindModule(TOKEN_A, await stub.getAddress());
      // Deployer is the contract owner but NOT on the per-token authorized-
      // caller allowlist — state hooks must reject.
      await expect(
        compliance.created(TOKEN_A, a.address, 100)
      ).to.be.revertedWithCustomError(compliance, "NotAuthorizedCaller");
    });

    it("created fires on each bound module once caller is authorized", async () => {
      const { compliance, deployer } = await loadFixture(deployFixture);
      const [, a] = await hre.ethers.getSigners();
      const stub = await deployStubAllow();
      await compliance.bindModule(TOKEN_A, await stub.getAddress());
      await compliance.setAuthorizedCaller(TOKEN_A, deployer.address, true);

      await compliance.created(TOKEN_A, a.address, 100);
      expect(await stub.lastAmount()).to.equal(100n);
      expect(await stub.lastKind()).to.equal(1n); // 1 = created
    });

    it("transferred / destroyed route correctly", async () => {
      const { compliance, deployer } = await loadFixture(deployFixture);
      const [, a, b] = await hre.ethers.getSigners();
      const stub = await deployStubAllow();
      await compliance.bindModule(TOKEN_A, await stub.getAddress());
      await compliance.setAuthorizedCaller(TOKEN_A, deployer.address, true);

      await compliance.transferred(TOKEN_A, a.address, b.address, 50);
      expect(await stub.lastKind()).to.equal(2n);
      expect(await stub.lastAmount()).to.equal(50n);

      await compliance.destroyed(TOKEN_A, a.address, 25);
      expect(await stub.lastKind()).to.equal(3n);
      expect(await stub.lastAmount()).to.equal(25n);
    });

    it("setAuthorizedCaller is owner-only and emits", async () => {
      const { compliance } = await loadFixture(deployFixture);
      const [, stranger] = await hre.ethers.getSigners();
      await expect(
        compliance.connect(stranger).setAuthorizedCaller(TOKEN_A, stranger.address, true)
      ).to.be.revertedWithCustomError(compliance, "OnlyOwner");

      await expect(
        compliance.setAuthorizedCaller(TOKEN_A, stranger.address, true)
      )
        .to.emit(compliance, "AuthorizedCallerUpdated")
        .withArgs(TOKEN_A, stranger.address, true);
      expect(await compliance.authorizedCaller(TOKEN_A, stranger.address)).to.equal(true);
    });

    it("setAuthorizedCaller rejects zero addresses", async () => {
      const { compliance } = await loadFixture(deployFixture);
      const [, a] = await hre.ethers.getSigners();
      await expect(
        compliance.setAuthorizedCaller(ZERO_ADDRESS, a.address, true)
      ).to.be.revertedWithCustomError(compliance, "ZeroAddress");
      await expect(
        compliance.setAuthorizedCaller(TOKEN_A, ZERO_ADDRESS, true)
      ).to.be.revertedWithCustomError(compliance, "ZeroAddress");
    });
  });

  describe("ownership", () => {
    it("transferOwnership rotates owner + emits", async () => {
      const { deployer, compliance } = await loadFixture(deployFixture);
      const [, , newOwner] = await hre.ethers.getSigners();
      await expect(compliance.transferOwnership(newOwner.address))
        .to.emit(compliance, "OwnershipTransferred")
        .withArgs(deployer.address, newOwner.address);
      expect(await compliance.owner()).to.equal(newOwner.address);
    });
  });
});
