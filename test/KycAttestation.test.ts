import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre from "hardhat";
import { expect } from "chai";
import {
  deployMuHavenFixture,
  deployKYCAttestationRegistry,
  deployMuHavenKYCVerifier,
} from "./helpers/setup";

const VALIDITY_PERIOD = 90n * 24n * 3600n; // 90 days
const SOURCE_CHAIN_ID = 421614n; // Arb Sepolia

describe("KYCAttestationRegistry + MuHavenKYCVerifier (P11.C stubs)", function () {

  async function deployFixture() {
    const base = await loadFixture(deployMuHavenFixture);
    const { deployer, kyc, investor } = base;

    // For tests, use a fresh ethers wallet as the off-chain signer so we
    // can sign EIP-712 attestations from JS.
    const signerWallet = hre.ethers.Wallet.createRandom();

    const registry = await deployKYCAttestationRegistry(
      await kyc.getAddress(),
      signerWallet.address,
      deployer.address,
      VALIDITY_PERIOD
    );

    const verifier = await deployMuHavenKYCVerifier(
      signerWallet.address,
      SOURCE_CHAIN_ID,
      await registry.getAddress(),
      deployer.address
    );

    return { ...base, registry, verifier, signerWallet, investor };
  }

  /// @dev Build the EIP-712 typed-data shape and sign it with `signer`.
  async function signAttestation(
    signer: any,
    verifyingContract: string,
    data: {
      investor: string;
      isVerified: boolean;
      tier: number;
      jurisdictionHash: string;
      nonce: bigint;
      issuedAt: bigint;
      expiresAt: bigint;
    }
  ): Promise<string> {
    const domain = {
      name: "MuHaven KYC Attestation",
      version: "1",
      chainId: SOURCE_CHAIN_ID,
      verifyingContract,
    };
    const types = {
      KYCAttestation: [
        { name: "investor", type: "address" },
        { name: "isVerified", type: "bool" },
        { name: "tier", type: "uint8" },
        { name: "jurisdictionHash", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "issuedAt", type: "uint256" },
        { name: "expiresAt", type: "uint256" },
      ],
    };
    return signer.signTypedData(domain, types, data);
  }

  // ── KYCAttestationRegistry ──────────────────────────────────────────────

  describe("KYCAttestationRegistry", function () {
    it("prepareAttestation returns tier 1 for whitelisted investor", async function () {
      const { registry, investor } = await loadFixture(deployFixture);
      const data = await registry.prepareAttestation(investor.address);
      expect(data.investor).to.equal(investor.address);
      expect(data.isVerified).to.equal(true);
      expect(data.tier).to.equal(1n);
      expect(data.nonce).to.equal(0n);
    });

    it("prepareAttestation returns tier 2 for accredited investor", async function () {
      const { registry, kyc, investor } = await loadFixture(deployFixture);
      await kyc.addToAccreditedList(investor.address);
      const data = await registry.prepareAttestation(investor.address);
      expect(data.tier).to.equal(2n);
    });

    it("revokeAttestation increments nonce + marks prior revoked", async function () {
      const { registry, deployer, investor } = await loadFixture(deployFixture);
      await expect(registry.connect(deployer).revokeAttestation(investor.address))
        .to.emit(registry, "AttestationRevoked")
        .withArgs(investor.address, 0n, 1n);

      expect(await registry.nonces(investor.address)).to.equal(1n);
      expect(await registry.revoked(investor.address, 0n)).to.equal(true);
      expect(await registry.isAttestationValid(investor.address, 0n)).to.equal(false);
      expect(await registry.isAttestationValid(investor.address, 1n)).to.equal(true);
    });

    it("rejects revokeAttestation from non-admin", async function () {
      const { registry, alice, investor } = await loadFixture(deployFixture);
      await expect(
        registry.connect(alice).revokeAttestation(investor.address)
      ).to.be.revertedWithCustomError(registry, "OnlyAdmin");
    });

    it("setJurisdictionHash propagates into prepareAttestation", async function () {
      const { registry, deployer, investor } = await loadFixture(deployFixture);
      const usHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("US"));
      await registry.connect(deployer).setJurisdictionHash(investor.address, usHash);
      const data = await registry.prepareAttestation(investor.address);
      expect(data.jurisdictionHash).to.equal(usHash);
    });
  });

  // ── MuHavenKYCVerifier ──────────────────────────────────────────────────

  describe("MuHavenKYCVerifier", function () {
    it("accepts a valid signed attestation", async function () {
      const { verifier, registry, signerWallet, investor } = await loadFixture(deployFixture);
      const usHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("US"));

      const issuedAt = BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp);
      const expiresAt = issuedAt + VALIDITY_PERIOD;
      const sig = await signAttestation(signerWallet, await registry.getAddress(), {
        investor: investor.address,
        isVerified: true,
        tier: 1,
        jurisdictionHash: usHash,
        nonce: 0n,
        issuedAt,
        expiresAt,
      });

      await expect(
        verifier.submitAttestation(
          investor.address, true, 1, usHash, 0, issuedAt, expiresAt, sig
        )
      ).to.emit(verifier, "AttestationSubmitted")
        .withArgs(investor.address, 1n, expiresAt);

      expect(await verifier.isEligible(investor.address)).to.equal(true);
      expect(await verifier.isEligibleForTier(investor.address, 1)).to.equal(true);
      expect(await verifier.isEligibleForTier(investor.address, 2)).to.equal(false);
    });

    it("rejects a signature from a wrong signer", async function () {
      const { verifier, registry, investor } = await loadFixture(deployFixture);
      const usHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("US"));
      const otherSigner = hre.ethers.Wallet.createRandom();

      const issuedAt = BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp);
      const expiresAt = issuedAt + VALIDITY_PERIOD;
      const sig = await signAttestation(otherSigner, await registry.getAddress(), {
        investor: investor.address,
        isVerified: true,
        tier: 1,
        jurisdictionHash: usHash,
        nonce: 0n,
        issuedAt,
        expiresAt,
      });

      await expect(
        verifier.submitAttestation(
          investor.address, true, 1, usHash, 0, issuedAt, expiresAt, sig
        )
      ).to.be.revertedWithCustomError(verifier, "InvalidSignature");
    });

    it("rejects an already-expired attestation", async function () {
      const { verifier, registry, signerWallet, investor } = await loadFixture(deployFixture);
      const usHash = hre.ethers.ZeroHash;

      const issuedAt = BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp) - 1000n;
      const expiresAt = issuedAt + 1n; // already expired
      const sig = await signAttestation(signerWallet, await registry.getAddress(), {
        investor: investor.address,
        isVerified: true,
        tier: 1,
        jurisdictionHash: usHash,
        nonce: 0n,
        issuedAt,
        expiresAt,
      });

      await expect(
        verifier.submitAttestation(
          investor.address, true, 1, usHash, 0, issuedAt, expiresAt, sig
        )
      ).to.be.revertedWithCustomError(verifier, "AttestationExpired");
    });

    it("rejects nonce rollback (defense in depth)", async function () {
      const { verifier, registry, signerWallet, investor } = await loadFixture(deployFixture);
      const usHash = hre.ethers.ZeroHash;
      const issuedAt = BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp);
      const expiresAt = issuedAt + VALIDITY_PERIOD;

      // Submit a nonce=2 attestation first.
      const sig2 = await signAttestation(signerWallet, await registry.getAddress(), {
        investor: investor.address,
        isVerified: true,
        tier: 1,
        jurisdictionHash: usHash,
        nonce: 2n,
        issuedAt,
        expiresAt,
      });
      await verifier.submitAttestation(
        investor.address, true, 1, usHash, 2, issuedAt, expiresAt, sig2
      );

      // Try to roll back to nonce=1.
      const sig1 = await signAttestation(signerWallet, await registry.getAddress(), {
        investor: investor.address,
        isVerified: true,
        tier: 1,
        jurisdictionHash: usHash,
        nonce: 1n,
        issuedAt,
        expiresAt,
      });
      await expect(
        verifier.submitAttestation(
          investor.address, true, 1, usHash, 1, issuedAt, expiresAt, sig1
        )
      ).to.be.revertedWithCustomError(verifier, "NonceNotMonotonic");
    });

    it("admin can invalidate; isEligible flips to false", async function () {
      const { verifier, registry, signerWallet, deployer, investor } = await loadFixture(deployFixture);
      const usHash = hre.ethers.ZeroHash;
      const issuedAt = BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp);
      const expiresAt = issuedAt + VALIDITY_PERIOD;
      const sig = await signAttestation(signerWallet, await registry.getAddress(), {
        investor: investor.address,
        isVerified: true,
        tier: 1,
        jurisdictionHash: usHash,
        nonce: 0n,
        issuedAt,
        expiresAt,
      });
      await verifier.submitAttestation(
        investor.address, true, 1, usHash, 0, issuedAt, expiresAt, sig
      );
      expect(await verifier.isEligible(investor.address)).to.equal(true);

      await verifier.connect(deployer).invalidateAttestation(investor.address);
      expect(await verifier.isEligible(investor.address)).to.equal(false);
    });

    it("supports IKYCGate via EIP-165", async function () {
      const { verifier } = await loadFixture(deployFixture);
      // IKYCGate id — derive dynamically.
      const id =
        BigInt(
          "0x" +
            (
              BigInt(hre.ethers.id("isEligible(address)").slice(0, 10)) ^
              BigInt(hre.ethers.id("isEligibleForTier(address,uint256)").slice(0, 10)) ^
              BigInt(hre.ethers.id("providerName()").slice(0, 10))
            ).toString(16).padStart(8, "0")
        );
      const idHex = "0x" + id.toString(16).padStart(8, "0");
      expect(await verifier.supportsInterface(idHex)).to.equal(true);
      expect(await verifier.supportsInterface("0xdeadbeef")).to.equal(false);
    });
  });
});
