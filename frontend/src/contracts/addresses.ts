/**
 * Contract address registry per network.
 * Active network selected by VITE_CHAIN_ID env var.
 */

export interface ContractAddresses {
  muHavenToken: `0x${string}`
  muHavenVault: `0x${string}`
  investorRegistry: `0x${string}`
  yieldDistributor: `0x${string}`
  kycAdapter: `0x${string}`
  riskParams: `0x${string}`
  yieldGate: `0x${string}`
  // External (ReineiraOS)
  usdc: `0x${string}`
  pusdc: `0x${string}`
  escrow: `0x${string}`
}

const arbSepolia: ContractAddresses = {
  muHavenToken: '0x05519F5c6b0b0626ACd5d7099efC91d9D8367c73',
  muHavenVault: '0x513A6Fe54c0b640e16d79CC20787421c17b16Db9',
  investorRegistry: '0x189D3BF72DB3b6b13E275e9Dce7cAAfFEBEeD40B',
  yieldDistributor: '0x15F7Da3E0CbBEF587314d4a2e73cc81Ead0f3218',
  kycAdapter: '0xdF7Cf475ceC7c6691f6c0776ed6Ed05AAa9bec77',
  riskParams: '0xE8C2C6a7A60C31f34a7735e70aa3C99eCC2ef145',
  yieldGate: '0x2de30627Cf17b973A0c1d01cfe665d2954A76B39',
  usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
  pusdc: '0x6b6e6479b8b3237933c3ab9d8be969862d4ed89f',
  escrow: '0xC4333F84F5034D8691CB95f068def2e3B6DC60Fa',
}

const addressMap: Record<string, ContractAddresses> = {
  '421614': arbSepolia, // Arbitrum Sepolia chain ID
}

const chainId = import.meta.env.VITE_CHAIN_ID || '421614'

export const addresses: ContractAddresses = addressMap[chainId] ?? arbSepolia
