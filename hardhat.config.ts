import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-ethers";
import "@openzeppelin/hardhat-upgrades";
import "@cofhe/hardhat-plugin";
import * as dotenv from "dotenv";

dotenv.config();

const config: HardhatUserConfig = {
  cofhe: {
    logMocks: true,
    gasWarning: true,
  },
  solidity: {
    version: "0.8.28",
    settings: {
      evmVersion: "cancun",
      // Optimizer enabled so MuHavenToken (Phase 4 Queue primitives pushed
      // it past the Spurious Dragon 24576-byte deploy limit) fits in a
      // regular proxy implementation slot. `runs=200` is the OZ/standard
      // default — tuned low would shave more bytes but hurts hot-path gas.
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  defaultNetwork: "hardhat",
  networks: {
    "arb-sepolia": {
      url: process.env.ARB_SEPOLIA_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 421614,
      gasMultiplier: 1.2,
      timeout: 60000,
      httpHeaders: {},
    },
    "base-sepolia": {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 84532,
      gasMultiplier: 1.2,
      timeout: 60000,
      httpHeaders: {},
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
    customChains: [
      {
        network: "arb-sepolia",
        chainId: 421614,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api?chainid=421614",
          browserURL: "https://sepolia.arbiscan.io",
        },
      },
      {
        network: "base-sepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api?chainid=84532",
          browserURL: "https://sepolia.basescan.org",
        },
      },
    ],
  },
};

export default config;
