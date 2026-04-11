/**
 * On-chain data source — reads BUIDL AUM and USDY price from Ethereum mainnet.
 *
 * Uses viem for contract reads via free public RPCs.
 * Gracefully falls back to null on any failure.
 */
import { createPublicClient, http, type PublicClient, parseAbi, getAddress } from 'viem';
import { mainnet } from 'viem/chains';
import { getConfig } from '../config.js';

export interface OnChainNavResult {
  value: number;
  timestamp: Date;
  aum?: number;
}

let ethClient: PublicClient | null = null;

function getEthClient(): PublicClient {
  if (!ethClient) {
    const config = getConfig();
    ethClient = createPublicClient({
      chain: mainnet,
      transport: http(config.ethMainnetRpcUrl),
    });
  }
  return ethClient;
}

// BlackRock BUIDL on Ethereum mainnet — Securitize DS token (restricted ERC-20).
// BUIDL is a money market fund with constant $1 NAV — yield accrues via share minting.
// We read totalSupply to track AUM; NAV is always $1.
const BUIDL_ADDRESS = getAddress('0x7712c34205737192402172409a8F7ccef8aA2AEc');
const BUIDL_ABI = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

let buidlDecimals: number | null = null;

/**
 * Read BUIDL AUM from Ethereum mainnet via totalSupply.
 * NAV is always $1 (money market fund). AUM = totalSupply / 10^decimals.
 */
export async function fetchBuidlNav(): Promise<OnChainNavResult | null> {
  try {
    const client = getEthClient();

    // Cache decimals — it never changes
    if (buidlDecimals === null) {
      buidlDecimals = Number(
        await client.readContract({ address: BUIDL_ADDRESS, abi: BUIDL_ABI, functionName: 'decimals' }),
      );
    }

    const totalSupply = await client.readContract({
      address: BUIDL_ADDRESS, abi: BUIDL_ABI, functionName: 'totalSupply',
    });

    const aum = Number(totalSupply) / 10 ** buidlDecimals;
    return { value: 1.0, timestamp: new Date(), aum };
  } catch (err: any) {
    console.warn(`BUIDL on-chain fetch failed: ${err.shortMessage ?? err.message}`);
    return null;
  }
}

// Ondo USDY — Redemption Price Oracle on Ethereum mainnet
// (no oracle deployed on Arbitrum — only the token contract)
const USDY_ORACLE_ADDRESS = getAddress('0xA0219AA5B31e65Bc920B5b6DFb8EdF0988121De0');
const USDY_ORACLE_ABI = parseAbi([
  'function getPrice() view returns (uint256)',
]);

/**
 * Read USDY price from Ethereum mainnet (Ondo Redemption Price Oracle).
 * Returns price in 18 decimals.
 */
export async function fetchUsdyPrice(): Promise<OnChainNavResult | null> {
  try {
    const client = getEthClient();

    const price = await client.readContract({
      address: USDY_ORACLE_ADDRESS,
      abi: USDY_ORACLE_ABI,
      functionName: 'getPrice',
    });

    const nav = Number(price) / 1e18;
    return { value: nav, timestamp: new Date() };
  } catch (err: any) {
    console.warn(`USDY on-chain fetch failed: ${err.shortMessage ?? err.message}`);
    return null;
  }
}
