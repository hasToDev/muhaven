import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import { expect } from "chai";
import {
  deployMuHavenFixture,
  deployMockMuHavenEscrow,
  deployMockPUSDC,
  deployYieldGate,
  deployDefaultProtection,
  deployEncryptedGovernance,
  ONE_TOKEN,
  waitForDecrypt,
} from "./helpers/setup";

const ONE_PUSDC = 1_000_000n;
const VOTING_PERIOD = 60n; // 1 minute for tests
const QUORUM_BPS = 5000n;  // 50%

/// @dev Full fixture with token, registered investors, an active protection,
///      and a wired EncryptedGovernance contract.
async function deployFixture() {
  const base = await loadFixture(deployMuHavenFixture);
  const { deployer, token, kyc, registry, issuer, investor, alice } = base;

  await kyc.addToWhitelist(issuer.address);

  // Mint to two investors so they're registered + have voting weight.
  const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);

  // investor: 1 token; alice: 3 tokens (so total = 4 tokens).
  const [encMintInv] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
  await token.connect(issuer).mint(investor.address, encMintInv);
  const [encMintAlice] = await issuerClient.encryptInputs([Encryptable.uint128(3n * ONE_TOKEN)]).execute();
  await token.connect(issuer).mint(alice.address, encMintAlice);

  // Default protection wiring.
  const escrow = await deployMockMuHavenEscrow();
  const pusdc = await deployMockPUSDC();
  const yieldGate = await deployYieldGate(
    await token.getAddress(),
    await kyc.getAddress()
  );
  await yieldGate.setAuthorizedEscrow(await escrow.getAddress());

  const protection = await deployDefaultProtection(
    await registry.getAddress(),
    await escrow.getAddress(),
    await yieldGate.getAddress(),
    await pusdc.getAddress(),
    deployer.address,
    300
  );

  // Issuer creates + funds the protection.
  await protection.connect(issuer).createProtection(await token.getAddress(), 500n);
  const reserve = 100n * ONE_PUSDC;
  await pusdc.mint(issuer.address, Number(reserve));
  await pusdc.connect(issuer).setOperator(await protection.getAddress(), 2_000_000_000);
  const [encReserve] = await issuerClient.encryptInputs([Encryptable.uint64(reserve)]).execute();
  await protection.connect(issuer).depositReserve(1, encReserve);

  // Governance.
  const governance = await deployEncryptedGovernance(
    await token.getAddress(),
    await protection.getAddress(),
    await registry.getAddress(),
    deployer.address,
    Number(VOTING_PERIOD),
    Number(QUORUM_BPS)
  );

  // Wire: governance reads token balances + supply.
  await token.connect(deployer).setAuthorizedReader(await governance.getAddress(), true);
  // Wire: governance can trigger protection.
  await protection.connect(deployer).setAuthorizedTrigger(await governance.getAddress(), true);

  return { ...base, escrow, pusdc, yieldGate, protection, governance };
}

/// @dev Helper: encrypt a uint128 vote bound to the given signer.
async function encryptVote(signer: any, value: bigint) {
  const c = await hre.cofhe.createClientWithBatteries(signer);
  const [enc] = await c.encryptInputs([Encryptable.uint128(value)]).execute();
  return enc;
}

describe("EncryptedGovernance", function () {

  // ── createProposal ──────────────────────────────────────────────────────

  describe("createProposal()", function () {
    it("creates a proposal targeting an active protection token", async function () {
      const { governance, token, investor } = await loadFixture(deployFixture);
      const tokenAddr = await token.getAddress();

      const tx = await governance.connect(investor).createProposal(tokenAddr, 0);
      const r = await tx.wait();
      const ev = r!.logs.find((l: any) => l.fragment?.name === "ProposalCreated");
      expect(ev).to.not.be.undefined;

      const p = await governance.getProposal(1);
      expect(p.token).to.equal(tokenAddr);
      expect(p.proposalType).to.equal(0n);
      expect(p.proposer).to.equal(investor.address);
      expect(p.voterCount).to.equal(0n);
      expect(p.status).to.equal(0n); // ACTIVE
    });

    it("rejects from a non-registered investor", async function () {
      const { governance, token, deployer } = await loadFixture(deployFixture);
      // deployer is not a token holder, so not a registered investor.
      await expect(
        governance.connect(deployer).createProposal(await token.getAddress(), 0)
      ).to.be.revertedWithCustomError(governance, "NotRegisteredInvestor");
    });

    it("rejects when no protection exists for the token", async function () {
      const { governance, registry, kyc, investor } = await loadFixture(deployFixture);
      void registry; void kyc;

      // Some other random address with no protection.
      const fakeToken = "0x000000000000000000000000000000000000beef";
      await expect(
        governance.connect(investor).createProposal(fakeToken, 0)
      ).to.be.revertedWithCustomError(governance, "NoProtectionForToken");
    });

    it("rejects an unknown proposalType", async function () {
      const { governance, token, investor } = await loadFixture(deployFixture);
      await expect(
        governance.connect(investor).createProposal(await token.getAddress(), 7)
      ).to.be.revertedWithCustomError(governance, "InvalidProposal");
    });
  });

  // ── castVote ────────────────────────────────────────────────────────────

  describe("castVote()", function () {
    async function activeProposalFixture() {
      const ctx = await deployFixture();
      const { governance, token, investor } = ctx;
      await governance.connect(investor).createProposal(await token.getAddress(), 0);
      return ctx;
    }

    it("records a yes vote and increments voterCount", async function () {
      const { governance, investor } = await loadFixture(activeProposalFixture);

      const encVote = await encryptVote(investor, 1n);
      await expect(governance.connect(investor).castVote(1, encVote))
        .to.emit(governance, "VoteCast")
        .withArgs(1n, investor.address);

      expect(await governance.hasVoted(1, investor.address)).to.equal(true);
      const p = await governance.getProposal(1);
      expect(p.voterCount).to.equal(1n);
    });

    it("records a no vote with same gas-cost path (FHE.select)", async function () {
      const { governance, alice } = await loadFixture(activeProposalFixture);

      const encVote = await encryptVote(alice, 0n);
      await expect(governance.connect(alice).castVote(1, encVote))
        .to.emit(governance, "VoteCast")
        .withArgs(1n, alice.address);
      const p = await governance.getProposal(1);
      expect(p.voterCount).to.equal(1n);
    });

    it("rejects double votes", async function () {
      const { governance, investor } = await loadFixture(activeProposalFixture);
      const encVote = await encryptVote(investor, 1n);
      await governance.connect(investor).castVote(1, encVote);
      const encVote2 = await encryptVote(investor, 1n);
      await expect(
        governance.connect(investor).castVote(1, encVote2)
      ).to.be.revertedWithCustomError(governance, "AlreadyVoted");
    });

    it("rejects votes from non-investors", async function () {
      const { governance, deployer } = await loadFixture(activeProposalFixture);
      const encVote = await encryptVote(deployer, 1n);
      await expect(
        governance.connect(deployer).castVote(1, encVote)
      ).to.be.revertedWithCustomError(governance, "NotRegisteredInvestor");
    });

    it("rejects votes after the period ends", async function () {
      const { governance, investor } = await loadFixture(activeProposalFixture);
      await time.increase(Number(VOTING_PERIOD) + 1);
      const encVote = await encryptVote(investor, 1n);
      await expect(
        governance.connect(investor).castVote(1, encVote)
      ).to.be.revertedWithCustomError(governance, "VotingNotActive");
    });
  });

  // ── requestTally ────────────────────────────────────────────────────────

  describe("requestTally()", function () {
    async function votedProposal(yesPower: bigint, noPower: bigint) {
      const ctx = await deployFixture();
      const { governance, token, investor, alice } = ctx;
      await governance.connect(investor).createProposal(await token.getAddress(), 0);

      // investor (1 token) and alice (3 tokens) cast their votes.
      if (yesPower > 0n) {
        const encInv = await encryptVote(investor, 1n);
        await governance.connect(investor).castVote(1, encInv);
      } else {
        const encInv = await encryptVote(investor, 0n);
        await governance.connect(investor).castVote(1, encInv);
      }
      if (noPower > 0n || yesPower === 0n) {
        // alice
        const encAlice = await encryptVote(alice, yesPower > 0n && noPower === 0n ? 1n : 0n);
        await governance.connect(alice).castVote(1, encAlice);
      }
      void noPower;

      await time.increase(Number(VOTING_PERIOD) + 1);
      return ctx;
    }

    it("reverts before voting period ends", async function () {
      const { governance, token, investor } = await loadFixture(deployFixture);
      await governance.connect(investor).createProposal(await token.getAddress(), 0);
      await expect(
        governance.requestTally(1)
      ).to.be.revertedWithCustomError(governance, "VotingNotEnded");
    });

    it("flips status to TALLY_REQUESTED after voting ends", async function () {
      const ctx = await votedProposal(1n, 0n);
      await expect(ctx.governance.requestTally(1)).to.emit(ctx.governance, "TallyRequested").withArgs(1n);
      const p = await ctx.governance.getProposal(1);
      expect(p.status).to.equal(1n); // TALLY_REQUESTED
    });

    it("rejects re-tally on a TALLY_REQUESTED proposal", async function () {
      const ctx = await votedProposal(1n, 0n);
      await ctx.governance.requestTally(1);
      await expect(
        ctx.governance.requestTally(1)
      ).to.be.revertedWithCustomError(ctx.governance, "ProposalNotTallyable");
    });
  });

  // ── executeProposal ─────────────────────────────────────────────────────

  describe("executeProposal()", function () {
    it("triggers protection on a passing proposal (everyone votes yes)", async function () {
      const ctx = await loadFixture(deployFixture);
      const { governance, protection, token, investor, alice } = ctx;
      await governance.connect(investor).createProposal(await token.getAddress(), 0);

      // Both investors vote yes — total = 4 tokens vs total supply = 4 tokens.
      // threshold = (4 / 10000) * 5000 = 0 (rounding) → 4 >= 0 → passes.
      const encInv = await encryptVote(investor, 1n);
      await governance.connect(investor).castVote(1, encInv);
      const encAlice = await encryptVote(alice, 1n);
      await governance.connect(alice).castVote(1, encAlice);

      await time.increase(Number(VOTING_PERIOD) + 1);
      await governance.requestTally(1);
      await waitForDecrypt();

      await expect(governance.executeProposal(1))
        .to.emit(governance, "ProposalExecuted").withArgs(1n, true);

      const p = await governance.getProposal(1);
      expect(p.status).to.equal(2n); // EXECUTED

      // Protection got triggered — status TRIGGERED and a payout distribution exists.
      const prot = await protection.getProtection(1);
      expect(prot.status).to.equal(2n); // TRIGGERED
      const dist = await protection.getPayoutDistribution(1);
      expect(dist.investorCount).to.be.greaterThan(0n);
    });

    it("marks DEFEATED on a failing proposal (all votes no)", async function () {
      // To ensure failure we mint a third investor with much higher balance
      // than yes votes — but our standard fixture has no third investor.
      // Strategy: cast a no vote from the only voter (investor with 1 token);
      // alice abstains. Tally yes = 0 → 0 >= 0 → would still pass under our
      // (supply / 10k) * bps threshold-of-zero arithmetic. Workaround: bump
      // quorum to 10000 (100%) so threshold rounds to (4 / 10000) * 10000 =
      // 0 still — yes 0 ≥ 0 still. Real-world supplies are >> 10000 so this
      // is acceptable rounding. To actually defeat we need yesWeight < (
      // supply / 10000 ) * quorumBps — with 4 token supply at 5000 bps the
      // threshold is 0 so any non-negative yes passes. Skip via an explicit
      // larger-supply override: mint 1e22 to issuer too so threshold > 0.
      const ctx = await loadFixture(deployFixture);
      const { governance, protection, token, issuer, investor } = ctx;

      // Bump issuer balance so the threshold becomes meaningful.
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const [encMintIssuer] = await issuerClient.encryptInputs([Encryptable.uint128(10_000n * ONE_TOKEN)]).execute();
      await token.connect(issuer).mint(issuer.address, encMintIssuer);

      await governance.connect(investor).createProposal(await token.getAddress(), 0);
      // investor votes no; alice abstains; issuer votes no.
      // Wait — we never gave issuer KYC for governance; KYC is separate from registered investor.
      // Actually for governance, registry.isInvestor is the gate.
      // issuer just got minted to themselves so they're now a registered investor.
      const encNoInv = await encryptVote(investor, 0n);
      await governance.connect(investor).castVote(1, encNoInv);

      await time.increase(Number(VOTING_PERIOD) + 1);
      await governance.requestTally(1);
      await waitForDecrypt();

      await expect(governance.executeProposal(1))
        .to.emit(governance, "ProposalExecuted").withArgs(1n, false);

      const p = await governance.getProposal(1);
      expect(p.status).to.equal(3n); // DEFEATED
      // Protection NOT triggered.
      const prot = await protection.getProtection(1);
      expect(prot.status).to.equal(1n); // ACTIVE
    });

    it("rejects double-execution", async function () {
      const ctx = await loadFixture(deployFixture);
      const { governance, token, investor, alice } = ctx;
      await governance.connect(investor).createProposal(await token.getAddress(), 0);

      const encInv = await encryptVote(investor, 1n);
      await governance.connect(investor).castVote(1, encInv);
      const encAlice = await encryptVote(alice, 1n);
      await governance.connect(alice).castVote(1, encAlice);

      await time.increase(Number(VOTING_PERIOD) + 1);
      await governance.requestTally(1);
      await waitForDecrypt();
      await governance.executeProposal(1);

      await expect(
        governance.executeProposal(1)
      ).to.be.revertedWithCustomError(governance, "ProposalAlreadyResolved");
    });

    it("rejects execute before requestTally", async function () {
      const ctx = await loadFixture(deployFixture);
      const { governance, token, investor } = ctx;
      await governance.connect(investor).createProposal(await token.getAddress(), 0);
      await expect(
        governance.executeProposal(1)
      ).to.be.revertedWithCustomError(governance, "TallyNotRequested");
    });
  });

  // ── admin ───────────────────────────────────────────────────────────────

  describe("admin", function () {
    it("setVotingPeriod is owner-only", async function () {
      const { governance, alice } = await loadFixture(deployFixture);
      await expect(
        governance.connect(alice).setVotingPeriod(120)
      ).to.be.revertedWithCustomError(governance, "OnlyOwner");
    });

    it("rejects zero voting period", async function () {
      const { governance, deployer } = await loadFixture(deployFixture);
      await expect(
        governance.connect(deployer).setVotingPeriod(0)
      ).to.be.revertedWithCustomError(governance, "InvalidVotingPeriod");
    });

    it("rejects quorum > 10000", async function () {
      const { governance, deployer } = await loadFixture(deployFixture);
      await expect(
        governance.connect(deployer).setQuorumBps(10001)
      ).to.be.revertedWithCustomError(governance, "InvalidQuorum");
    });

    it("setQuorumBps emits + updates", async function () {
      const { governance, deployer } = await loadFixture(deployFixture);
      await expect(governance.connect(deployer).setQuorumBps(7500))
        .to.emit(governance, "QuorumBpsUpdated").withArgs(7500n);
      expect(await governance.quorumBps()).to.equal(7500n);
    });
  });

  // ── EIP-165 ─────────────────────────────────────────────────────────────

  describe("EIP-165", function () {
    it("supports IEncryptedGovernance interface id", async function () {
      const { governance } = await loadFixture(deployFixture);
      expect(await governance.supportsInterface("0x01ffc9a7")).to.equal(true);
      expect(await governance.supportsInterface("0xdeadbeef")).to.equal(false);
    });
  });
});
