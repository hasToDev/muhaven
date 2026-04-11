import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre from "hardhat";
import { expect } from "chai";
import {
  deployMuHavenFixture,
  deployMockReineiraEscrow,
  deployMockPUSDC,
} from "./helpers/setup";
import { upgrades } from "hardhat";

/// @dev IERC165 interfaceId — all ERC165 contracts must support this.
const IERC165_ID = "0x01ffc9a7";
/// @dev Invalid interfaceId — no contract should support this.
const INVALID_ID = "0xffffffff";

describe("EIP-165 supportsInterface", function () {
  async function deployAllFixture() {
    const base = await loadFixture(deployMuHavenFixture);
    const { deployer, token, kyc, registry } = base;

    const escrow = await deployMockReineiraEscrow();
    const pusdc = await deployMockPUSDC();

    // YieldGate
    const YieldGate = await hre.ethers.getContractFactory("YieldGate");
    const yieldGate = await YieldGate.deploy(
      await token.getAddress(),
      await kyc.getAddress()
    );

    // YieldDistributor
    const YieldDistributor = await hre.ethers.getContractFactory("YieldDistributor");
    const distributor = await upgrades.deployProxy(
      YieldDistributor,
      [
        await registry.getAddress(),
        await escrow.getAddress(),
        await yieldGate.getAddress(),
        deployer.address,
        await pusdc.getAddress(),
      ],
      { kind: "transparent", initializer: "initialize" }
    );

    return { ...base, escrow, pusdc, yieldGate, distributor };
  }

  describe("MuHavenToken", function () {
    it("should support IERC165", async function () {
      const { token } = await loadFixture(deployAllFixture);
      expect(await token.supportsInterface(IERC165_ID)).to.be.true;
    });

    it("should support IMuHavenToken", async function () {
      const { token } = await loadFixture(deployAllFixture);
      // Computed from compiled ABI (FHE types have specific ABI encodings)
      expect(await token.supportsInterface("0xb70f66dd")).to.be.true;
    });

    it("should NOT support invalid interfaceId", async function () {
      const { token } = await loadFixture(deployAllFixture);
      expect(await token.supportsInterface(INVALID_ID)).to.be.false;
    });
  });

  describe("MuHavenVault", function () {
    it("should support IERC165", async function () {
      const { vault } = await loadFixture(deployAllFixture);
      expect(await vault.supportsInterface(IERC165_ID)).to.be.true;
    });

    it("should NOT support invalid interfaceId", async function () {
      const { vault } = await loadFixture(deployAllFixture);
      expect(await vault.supportsInterface(INVALID_ID)).to.be.false;
    });
  });

  describe("ERC3643KYCAdapter", function () {
    it("should support IERC165", async function () {
      const { kyc } = await loadFixture(deployAllFixture);
      expect(await kyc.supportsInterface(IERC165_ID)).to.be.true;
    });

    it("should support IKYCGate", async function () {
      const { kyc } = await loadFixture(deployAllFixture);
      const iface = new hre.ethers.Interface([
        "function isEligible(address) view returns (bool)",
        "function isEligibleForTier(address,uint256) view returns (bool)",
        "function providerName() view returns (string)",
      ]);
      let interfaceId = 0n;
      for (const frag of iface.fragments) {
        if (frag.type === "function") {
          const selector = BigInt(iface.getFunction(frag.name)!.selector);
          interfaceId ^= selector;
        }
      }
      const interfaceIdHex = "0x" + interfaceId.toString(16).padStart(8, "0");
      expect(await kyc.supportsInterface(interfaceIdHex)).to.be.true;
    });

    it("should NOT support invalid interfaceId", async function () {
      const { kyc } = await loadFixture(deployAllFixture);
      expect(await kyc.supportsInterface(INVALID_ID)).to.be.false;
    });
  });

  describe("YieldDistributor", function () {
    it("should support IERC165", async function () {
      const { distributor } = await loadFixture(deployAllFixture);
      expect(await distributor.supportsInterface(IERC165_ID)).to.be.true;
    });

    it("should support IYieldDistributor", async function () {
      const { distributor } = await loadFixture(deployAllFixture);
      // Computed from compiled ABI (FHE types have specific ABI encodings)
      expect(await distributor.supportsInterface("0x8157df9c")).to.be.true;
    });

    it("should NOT support invalid interfaceId", async function () {
      const { distributor } = await loadFixture(deployAllFixture);
      expect(await distributor.supportsInterface(INVALID_ID)).to.be.false;
    });
  });

  describe("YieldGate", function () {
    it("should support IERC165", async function () {
      const { yieldGate } = await loadFixture(deployAllFixture);
      expect(await yieldGate.supportsInterface(IERC165_ID)).to.be.true;
    });

    it("should support IConditionResolver", async function () {
      const { yieldGate } = await loadFixture(deployAllFixture);
      // IConditionResolver = isConditionMet(uint256) ^ onConditionSet(uint256,bytes)
      const iface = new hre.ethers.Interface([
        "function isConditionMet(uint256) view returns (bool)",
        "function onConditionSet(uint256,bytes)",
      ]);
      let interfaceId = 0n;
      for (const frag of iface.fragments) {
        if (frag.type === "function") {
          const selector = BigInt(iface.getFunction(frag.name)!.selector);
          interfaceId ^= selector;
        }
      }
      const interfaceIdHex = "0x" + interfaceId.toString(16).padStart(8, "0");
      expect(await yieldGate.supportsInterface(interfaceIdHex)).to.be.true;
    });

    it("should NOT support invalid interfaceId", async function () {
      const { yieldGate } = await loadFixture(deployAllFixture);
      expect(await yieldGate.supportsInterface(INVALID_ID)).to.be.false;
    });
  });
});
