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
  muhavenEscrow: `0x${string}`
  // External (ReineiraOS)
  usdc: `0x${string}`
  pusdc: `0x${string}`
}

const arbSepolia: ContractAddresses = {
  muHavenToken: '0xF95c9aA19e974e4cA0778AAdb76580423eEEeb03',
  muHavenVault: '0xF445898f1af1DFde88E26c75C4d35c9025C5C631',
  investorRegistry: '0x9e19cFC63661AF1624ba16392dc02134F91d36f6',
  yieldDistributor: '0xD403252436e41EFd81D76eB9223485cB66cb1638',
  kycAdapter: '0x0aF7003E645b3f8028dac59556aa0Cf0AeA21851',
  riskParams: '0x7F287982232De3C78c1958Aa11f3D9826B445604',
  yieldGate: '0x2cBAa54E5Ce4ED6D68722e35E18eba77B1c11964',
  muhavenEscrow: '0xb18ca2122b31Df9Aaef8226f6218Bd93B852F40A',
  usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
  pusdc: '0x6b6e6479b8b3237933c3ab9d8be969862d4ed89f',
}

const addressMap: Record<string, ContractAddresses> = {
  '421614': arbSepolia, // Arbitrum Sepolia chain ID
}

const chainId = import.meta.env.VITE_CHAIN_ID || '421614'

export const addresses: ContractAddresses = addressMap[chainId] ?? arbSepolia
