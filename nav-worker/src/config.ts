/**
 * NAV Worker configuration — reads from environment variables.
 */

export interface Config {
  port: number;
  databaseUrl: string;
  fetchIntervalMs: number;
  fredApiKey: string;
  ethMainnetRpcUrl: string;
  arbRpcUrl: string;
}

let cached: Config | null = null;

export function getConfig(): Config {
  if (cached) return cached;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const fredApiKey = process.env.FRED_API_KEY ?? '';
  if (!fredApiKey) {
    console.warn('FRED_API_KEY not set — FRED API source will use fallback rates');
  }

  cached = {
    port: Number(process.env.PORT) || 3002,
    databaseUrl,
    fetchIntervalMs: Number(process.env.NAV_FETCH_INTERVAL_MS) || 3_600_000,
    fredApiKey,
    ethMainnetRpcUrl: process.env.ETH_MAINNET_RPC_URL || 'https://eth.llamarpc.com',
    arbRpcUrl: process.env.ARB_RPC_URL || 'https://arb1.arbitrum.io/rpc',
  };

  return cached;
}
