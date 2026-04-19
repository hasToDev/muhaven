import type { Address } from 'viem'

export const BASE_URL = process.env.E2E_BASE_URL ?? 'https://muhaven.hasto.dev'
export const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'https://nagreg.hasto.dev'
export const RPC_URL =
  process.env.ARB_SEPOLIA_RPC_URL ?? 'https://sepolia-rollup.arbitrum.io/rpc'

export const INVESTOR_PASSKEY_NAME =
  process.env.E2E_INVESTOR_PASSKEY_NAME ?? 'E2E Investor'
export const ISSUER_PASSKEY_NAME =
  process.env.E2E_ISSUER_PASSKEY_NAME ?? 'E2E Issuer'

export const DEPOSIT_AMOUNT = process.env.E2E_DEPOSIT_AMOUNT ?? '100'
export const WRAP_AMOUNT = process.env.E2E_WRAP_AMOUNT ?? '10'
export const DISTRIBUTE_AMOUNT = process.env.E2E_DISTRIBUTE_AMOUNT ?? '0.5'

/** Deployed contract addresses on Arb Sepolia — mirrors deployments/arb-sepolia.json. */
export const ADDR = {
  kycAdapter: '0x0aF7003E645b3f8028dac59556aa0Cf0AeA21851',
  investorRegistry: '0x9e19cFC63661AF1624ba16392dc02134F91d36f6',
  muHavenToken: '0xF95c9aA19e974e4cA0778AAdb76580423eEEeb03',
  riskParams: '0x7F287982232De3C78c1958Aa11f3D9826B445604',
  yieldGate: '0x2cBAa54E5Ce4ED6D68722e35E18eba77B1c11964',
  muhavenEscrow: '0xb18ca2122b31Df9Aaef8226f6218Bd93B852F40A',
  yieldDistributor: '0xD403252436e41EFd81D76eB9223485cB66cb1638',
  muHavenVault: '0xF445898f1af1DFde88E26c75C4d35c9025C5C631',
  usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
  pusdc: '0x6b6e6479b8b3237933c3ab9d8be969862d4ed89f',
  testTreasury: '0x580621f5FC5fF3d7912a570839AC1eb55F44a999',
} as const satisfies Record<string, Address>
