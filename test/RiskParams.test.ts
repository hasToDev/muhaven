import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import { expect } from "chai";
import { deployMuHavenFixture, deployRiskParams, waitForDecrypt } from "./helpers/setup";

describe("RiskParams", function () {
  async function deployRiskParamsFixture() {
    await hre.run("task:cofhe-mocks:deploy");
    const { investor, deployer } = await loadFixture(deployMuHavenFixture);
    const riskParams = await deployRiskParams();
    return { riskParams, investor, deployer };
  }

  describe("setRiskParams()", function () {
    it("should store encrypted risk params and mark hasRiskParams", async function () {
      const { riskParams, investor } = await loadFixture(deployRiskParamsFixture);
      const investorClient = await hre.cofhe.createClientWithBatteries(investor);

      const [encMd, encMy, encDt, encMs] = await investorClient.encryptInputs([
        Encryptable.uint64(500n),   // maxDrawdownBps
        Encryptable.uint64(400n),   // minYieldBps
        Encryptable.uint64(500n),   // driftToleranceBps
        Encryptable.uint64(1000n),  // maxDailySpend
      ]).execute();

      await riskParams.connect(investor).setRiskParams(encMd, encMy, encDt, encMs);

      expect(await riskParams.hasRiskParams(investor.address)).to.be.true;
    });
  });

  describe("requestRiskParamsDecrypt() + getRiskParamsDecryptResult()", function () {
    it("should return decrypted params after time.increase(11)", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployRiskParamsFixture);
      const investorClient = await hre.cofhe.createClientWithBatteries(investor);

      const [encMd, encMy, encDt, encMs] = await investorClient.encryptInputs([
        Encryptable.uint64(500n),
        Encryptable.uint64(400n),
        Encryptable.uint64(500n),
        Encryptable.uint64(1000n),
      ]).execute();

      await riskParams.connect(investor).setRiskParams(encMd, encMy, encDt, encMs);

      // Owner or investor can request decryption
      await riskParams.connect(investor).requestRiskParamsDecrypt(investor.address);
      await waitForDecrypt();

      const [md, my, dt, ms, mdReady, myReady, dtReady, msReady] =
        await riskParams.getRiskParamsDecryptResult(investor.address);

      expect(mdReady).to.be.true;
      expect(myReady).to.be.true;
      expect(md).to.equal(500n);
      expect(my).to.equal(400n);
    });

    it("should revert getRiskParamsDecryptResult when no params set", async function () {
      const { riskParams, investor } = await loadFixture(deployRiskParamsFixture);
      await expect(
        riskParams.getRiskParamsDecryptResult(investor.address)
      ).to.be.reverted;
    });
  });
});
