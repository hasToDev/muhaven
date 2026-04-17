import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre from "hardhat";
import { expect } from "chai";
import {
  deployMuHavenFixture,
  deployMockMuHavenEscrow,
  deployMockPUSDC,
  deployYieldGate,
  deployYieldDistributor,
  deployMuHavenEscrow,
} from "./helpers/setup";

/// @dev IERC165 interfaceId — all ERC165 contracts must support this.
const IERC165_ID = "0x01ffc9a7";
/// @dev Invalid interfaceId — no contract should support this.
const INVALID_ID = "0xffffffff";

/// XOR of all function selectors in an ABI — ERC-165 interfaceId.
function interfaceIdFromAbi(abi: string[]): string {
  const iface = new hre.ethers.Interface(abi);
  let id = 0n;
  for (const frag of iface.fragments) {
    if (frag.type === "function") {
      id ^= BigInt(iface.getFunction(frag.name)!.selector);
    }
  }
  return "0x" + id.toString(16).padStart(8, "0");
}

describe("EIP-165 supportsInterface", function () {
  async function deployAllFixture() {
    const base = await loadFixture(deployMuHavenFixture);
    const { deployer, token, kyc, registry } = base;

    const escrow = await deployMockMuHavenEscrow();
    const pusdc = await deployMockPUSDC();
    const yieldGate = await deployYieldGate(await token.getAddress(), await kyc.getAddress());
    const distributor = await deployYieldDistributor(
      await registry.getAddress(),
      await escrow.getAddress(),
      await yieldGate.getAddress(),
      deployer.address,
      await pusdc.getAddress()
    );
    // Real (proxied) MuHavenEscrow for its own supportsInterface check
    const realEscrow = await deployMuHavenEscrow(deployer.address, await pusdc.getAddress());

    return { ...base, escrow, realEscrow, pusdc, yieldGate, distributor };
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
      const interfaceId = interfaceIdFromAbi([
        "function isEligible(address) view returns (bool)",
        "function isEligibleForTier(address,uint256) view returns (bool)",
        "function providerName() view returns (string)",
      ]);
      expect(await kyc.supportsInterface(interfaceId)).to.be.true;
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
      // InEuint64 struct: (uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature).
      // All encrypted type aliases (euint64) wrap bytes32 in canonical ABI form.
      const interfaceId = interfaceIdFromAbi([
        "function startDistribution((uint256,uint8,uint8,bytes)) returns (uint256)",
        "function startDistributionFromBalance() returns (uint256)",
        "function setEscrowIds(uint256,uint256[])",
        "function processBatch(uint256,uint256)",
        "function isDistributionComplete(uint256) view returns (bool)",
        "function getDistribution(uint256) view returns (address,bytes32,bytes32,uint256,uint256,uint256,uint8)",
        "function getEscrowIds(uint256) view returns (uint256[])",
        "function encryptedTotalYieldDistributed() view returns (bytes32)",
      ]);
      expect(await distributor.supportsInterface(interfaceId)).to.be.true;
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
      // IConditionResolver = onConditionSet(uint256,bytes) ^ canRedeem(uint256)
      // canRedeem returns ebool (bytes32), is NOT view.
      const interfaceId = interfaceIdFromAbi([
        "function onConditionSet(uint256,bytes)",
        "function canRedeem(uint256) returns (bytes32)",
      ]);
      expect(await yieldGate.supportsInterface(interfaceId)).to.be.true;
    });

    it("should NOT support invalid interfaceId", async function () {
      const { yieldGate } = await loadFixture(deployAllFixture);
      expect(await yieldGate.supportsInterface(INVALID_ID)).to.be.false;
    });
  });

  describe("MuHavenEscrow", function () {
    it("should support IERC165", async function () {
      const { realEscrow } = await loadFixture(deployAllFixture);
      expect(await realEscrow.supportsInterface(IERC165_ID)).to.be.true;
    });

    it("should support IMuHavenEscrow", async function () {
      const { realEscrow } = await loadFixture(deployAllFixture);
      // InEaddress: (uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature)
      // eaddress/euint64/ebool all wrap bytes32.
      const interfaceId = interfaceIdFromAbi([
        "function batchCreate((uint256,uint8,uint8,bytes)[],address,bytes[]) returns (uint256[])",
        "function fundFrom(uint256,bytes32)",
        "function redeem(uint256)",
        "function redeemMultiple(uint256[])",
        "function exists(uint256) view returns (bool)",
        "function getOwner(uint256) view returns (bytes32)",
        "function getPaidAmount(uint256) view returns (bytes32)",
        "function getIsRedeemed(uint256) view returns (bytes32)",
        "function getResolver(uint256) view returns (address)",
        "function total() view returns (uint256)",
      ]);
      expect(await realEscrow.supportsInterface(interfaceId)).to.be.true;
    });

    it("should NOT support invalid interfaceId", async function () {
      const { realEscrow } = await loadFixture(deployAllFixture);
      expect(await realEscrow.supportsInterface(INVALID_ID)).to.be.false;
    });
  });
});
