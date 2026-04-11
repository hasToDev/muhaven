/**
 * scripts/deploy-mocks.ts
 *
 * Standalone utility: deploy TestTreasury for manual vault testing.
 *
 * Use this when you need a pre-minted ERC-20 on a live network (testnet/localhost)
 * without running the full deployment. The deployed address can then be set as
 * UNDERLYING_TOKEN_ADDRESS in .env before running deploy.ts.
 *
 *   pnpm run deploy:mocks                          # hardhat in-process
 *   pnpm run deploy:mocks:testnet                  # Arbitrum Sepolia
 *   pnpm hardhat run scripts/deploy-mocks.ts --network localhost
 *
 * Output: deployments/{network}.mocks.json
 */

import { ethers, network } from "hardhat";
import { writeFileSync, mkdirSync, existsSync, copyFileSync } from "fs";
import { join } from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = network.name;

  console.log(`\nDeploying mock contracts to [${net}]`);
  console.log(`Deployer: ${deployer.address}\n`);

  const initialSupply = ethers.parseUnits("10000000", 18); // 10M tokens

  console.log("Deploying TestTreasury...");
  const Factory = await ethers.getContractFactory("TestTreasury");
  const treasury = await Factory.deploy("Test Treasury Token", "tRWA", initialSupply);
  await treasury.waitForDeployment();
  const addr = await treasury.getAddress();
  console.log(`   TestTreasury: ${addr}`);

  const outDir = join(__dirname, "..", "deployments");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${net}.mocks.json`);

  if (existsSync(outPath)) {
    const historyDir = join(outDir, "history");
    mkdirSync(historyDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = join(historyDir, `${net}.mocks.${ts}.json`);
    copyFileSync(outPath, archivePath);
    console.log(`\nArchived previous mocks → deployments/history/${net}.mocks.${ts}.json`);
  }

  writeFileSync(
    outPath,
    JSON.stringify(
      {
        network: net,
        timestamp: new Date().toISOString(),
        deployer: deployer.address,
        TestTreasury: addr,
      },
      null,
      2,
    ),
  );

  console.log(`\nMocks saved → deployments/${net}.mocks.json`);
  console.log(`\nSet in .env for testnet vault deploy:`);
  console.log(`  UNDERLYING_TOKEN_ADDRESS=${addr}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
