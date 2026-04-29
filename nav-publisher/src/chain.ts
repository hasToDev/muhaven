/**
 * Chain wiring — viem public + wallet client around the
 * IssuerControlledOracle proxy.
 *
 * Exposes a focused surface so `publisher.ts` does not import viem
 * primitives directly (keeps testing and future-mode-additions simple).
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { getConfig } from './config.js';

/**
 * Minimal ABI — only the surface this service consumes. Keeping it in
 * the service avoids pulling in the full Hardhat artifacts pipeline.
 * Mirrors `scripts/refresh-oracle.ts`.
 */
export const ORACLE_ABI = [
  {
    type: 'function',
    name: 'getNAV',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      { name: 'nav', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'isFresh',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'getNavWriter',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'getMaxStaleness',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'setNAV',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'newNAV', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

export interface ChainContext {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: PrivateKeyAccount;
  oracle: Address;
}

let cached: ChainContext | null = null;

export function getChain(): ChainContext {
  if (cached) return cached;

  const config = getConfig();
  const account = privateKeyToAccount(config.publisherPrivateKey);

  const chain = defineChain({
    id: config.chainId,
    name: `chain-${config.chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });

  const transport = http(config.rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });

  cached = {
    publicClient,
    walletClient,
    account,
    oracle: config.oracleAddress,
  };
  return cached;
}

export interface NavView {
  nav: bigint;
  updatedAt: bigint;
  isFresh: boolean;
  navWriter: Address;
}

/**
 * Single round-trip oracle read for one token. Bundled into one
 * `multicall` call when the publicClient supports it (Arbitrum does).
 */
export async function readOracleView(token: Address): Promise<NavView> {
  const { publicClient, oracle } = getChain();
  const [nav, isFresh, navWriter] = await Promise.all([
    publicClient.readContract({
      address: oracle,
      abi: ORACLE_ABI,
      functionName: 'getNAV',
      args: [token],
    }) as Promise<readonly [bigint, bigint]>,
    publicClient.readContract({
      address: oracle,
      abi: ORACLE_ABI,
      functionName: 'isFresh',
      args: [token],
    }) as Promise<boolean>,
    publicClient.readContract({
      address: oracle,
      abi: ORACLE_ABI,
      functionName: 'getNavWriter',
      args: [token],
    }) as Promise<Address>,
  ]);
  return {
    nav: nav[0],
    updatedAt: nav[1],
    isFresh,
    navWriter,
  };
}

/**
 * Submit a setNAV transaction and wait for one confirmation.
 * Throws on revert; caller decides retry policy.
 */
export async function submitSetNav(
  token: Address,
  newNav: bigint,
  confirmTimeoutMs: number,
): Promise<`0x${string}`> {
  const { walletClient, publicClient, account, oracle } = getChain();

  const hash = await walletClient.writeContract({
    address: oracle,
    abi: ORACLE_ABI,
    functionName: 'setNAV',
    args: [token, newNav],
    account,
    chain: walletClient.chain,
  });

  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    timeout: confirmTimeoutMs,
  });
  if (receipt.status !== 'success') {
    throw new Error(`setNAV reverted (tx ${hash})`);
  }
  return hash;
}
