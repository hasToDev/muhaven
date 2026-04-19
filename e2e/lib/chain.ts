import {
  createPublicClient,
  http,
  type Address,
  type PublicClient,
} from 'viem'
import { arbitrumSepolia } from 'viem/chains'
import { ADDR, RPC_URL } from './env.js'

export const publicClient: PublicClient = createPublicClient({
  chain: arbitrumSepolia,
  transport: http(RPC_URL),
})

const kycAbi = [
  {
    name: 'isWhitelisted',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'address', name: 'who' }],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'isAccredited',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'address', name: 'who' }],
    outputs: [{ type: 'bool' }],
  },
] as const

const registryAbi = [
  {
    name: 'investorCount',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const

// Solidity's auto-generated public getter for `mapping(address => bool) public authorizedCallers`.
// Function name matches the storage variable — NOT `isAuthorizedCaller`.
// Verified against: contracts/YieldDistributor.sol:79, contracts/MuHavenEscrow.sol:70.
const authorizedCallersAbi = [
  {
    name: 'authorizedCallers',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
] as const

const erc20Abi = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'address', name: 'owner' }],
    outputs: [{ type: 'uint256' }],
  },
] as const

const distributorAbi = [
  {
    name: 'distributionCount',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const

export async function isWhitelisted(addr: Address): Promise<boolean> {
  return publicClient.readContract({
    address: ADDR.kycAdapter,
    abi: kycAbi,
    functionName: 'isWhitelisted',
    args: [addr],
  })
}

export async function isAccredited(addr: Address): Promise<boolean> {
  return publicClient.readContract({
    address: ADDR.kycAdapter,
    abi: kycAbi,
    functionName: 'isAccredited',
    args: [addr],
  })
}

export async function investorCount(): Promise<bigint> {
  return publicClient.readContract({
    address: ADDR.investorRegistry,
    abi: registryAbi,
    functionName: 'investorCount',
  })
}

export async function isAuthorizedOnYieldDistributor(addr: Address): Promise<boolean> {
  return publicClient.readContract({
    address: ADDR.yieldDistributor,
    abi: authorizedCallersAbi,
    functionName: 'authorizedCallers',
    args: [addr],
  })
}

export async function isAuthorizedOnEscrow(addr: Address): Promise<boolean> {
  return publicClient.readContract({
    address: ADDR.muhavenEscrow,
    abi: authorizedCallersAbi,
    functionName: 'authorizedCallers',
    args: [addr],
  })
}

export async function usdcBalance(addr: Address): Promise<bigint> {
  return publicClient.readContract({
    address: ADDR.usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [addr],
  })
}

export async function testTreasuryBalance(addr: Address): Promise<bigint> {
  return publicClient.readContract({
    address: ADDR.testTreasury,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [addr],
  })
}

/**
 * NOTE: PUSDC.balanceOf returns a pseudo-random indicator tick, NOT the actual
 * confidential balance. Do not use this for preflight thresholds — the real
 * balance lives in the encrypted portion that only the issuer can decrypt.
 * See POST_HACKATHON.md § "PUSDC forwarding architecture note".
 *
 * Retained here for debugging / logging only.
 */
export async function pusdcPublicIndicator(addr: Address): Promise<bigint> {
  return publicClient.readContract({
    address: ADDR.pusdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [addr],
  })
}

export async function distributionCount(): Promise<bigint> {
  return publicClient.readContract({
    address: ADDR.yieldDistributor,
    abi: distributorAbi,
    functionName: 'distributionCount',
  })
}
