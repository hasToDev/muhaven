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
/**
 * Minimal ABI for `TokenRegistry` — enumeration only. Used by
 * `discoverActiveTokens()` at startup to populate the publisher's
 * roster from on-chain state (Design A, 2026-05-17). Avoiding the full
 * registry artifact keeps the dep surface flat.
 */
export const TOKEN_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'getRegisteredTokens',
    stateMutability: 'view',
    inputs: [
      { name: 'offset', type: 'uint256' },
      { name: 'limit', type: 'uint256' },
    ],
    outputs: [{ type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'registeredTokenCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getConfig',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'active', type: 'bool' },
          { name: 'treasury', type: 'address' },
          { name: 'queue', type: 'address' },
          { name: 'oracle', type: 'address' },
          { name: 'issuer', type: 'address' },
          { name: 'minInvestment', type: 'uint128' },
          { name: 'instantRedeemCap', type: 'uint128' },
          { name: 'epochDuration', type: 'uint32' },
          { name: 'paused', type: 'bool' },
        ],
      },
    ],
  },
] as const;

/**
 * Minimal ABI for ERC20 `symbol()` — used to enrich the publisher's
 * log readability when on-chain enumeration discovers tokens not in the
 * symbols map.
 */
export const ERC20_SYMBOL_ABI = [
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
] as const;

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

/**
 * Enumerate active tokens from on-chain `TokenRegistry` (Design A,
 * 2026-05-17). Called once at startup when `NAV_PUBLISH_TOKENS` is
 * empty so the publisher's roster reflects current on-chain state
 * (including apply-issuer-onboarded tokens, which the prior static-env
 * roster missed).
 *
 * Filters:
 *   - `active = true` (the registry's lifecycle flag — inactive tokens
 *     are deregistered or never fully wired).
 *   - Paused tokens are STILL included: pausing freezes purchases but
 *     does NOT change the staleness expectation. A paused token whose
 *     NAV is allowed to drift would still revert any downstream call
 *     once unpaused. Keep them in the roster so they stay fresh.
 *
 * Symbol enrichment is best-effort — a token without a `symbol()` view
 * still gets enumerated; only the log-pretty name is missing.
 */
export async function discoverActiveTokens(): Promise<
  { address: Address; symbol?: string }[]
> {
  const { publicClient } = getChain();
  const config = getConfig();
  const registry = config.tokenRegistryAddress;

  const count: bigint = (await publicClient.readContract({
    address: registry,
    abi: TOKEN_REGISTRY_ABI,
    functionName: 'registeredTokenCount',
  })) as bigint;

  const all: Address[] = [];
  const pageSize = 100n;
  for (let off = 0n; off < count; off += pageSize) {
    const page = (await publicClient.readContract({
      address: registry,
      abi: TOKEN_REGISTRY_ABI,
      functionName: 'getRegisteredTokens',
      args: [off, pageSize],
    })) as readonly Address[];
    all.push(...page);
  }

  // Filter to active; collect oracle field too for sanity check that all
  // active tokens point at our oracle (a token wired to a DIFFERENT
  // oracle proxy is outside this publisher's responsibility).
  const result: { address: Address; symbol?: string }[] = [];
  for (const tokenAddr of all) {
    const cfg = (await publicClient.readContract({
      address: registry,
      abi: TOKEN_REGISTRY_ABI,
      functionName: 'getConfig',
      args: [tokenAddr],
    })) as {
      active: boolean;
      oracle: Address;
      paused: boolean;
    };
    if (!cfg.active) continue;
    if (cfg.oracle.toLowerCase() !== config.oracleAddress.toLowerCase()) {
      // Token uses a different oracle proxy (e.g. Chainlink Functions).
      // This publisher only manages the IssuerControlledOracle roster.
      continue;
    }

    let symbol: string | undefined;
    try {
      symbol = (await publicClient.readContract({
        address: tokenAddr,
        abi: ERC20_SYMBOL_ABI,
        functionName: 'symbol',
      })) as string;
    } catch {
      // Token doesn't expose symbol() — fine, just no pretty name.
    }
    result.push({ address: tokenAddr, symbol });
  }

  return result;
}
