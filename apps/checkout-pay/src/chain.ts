/**
 * Wave 4 P5 (Wave-5 buyer-side port, P1) — chain config + viem clients.
 *
 * Factored out so the P1 passkey ceremony, P2 USDC balance poll, and P3
 * wrap+approve+buy ceremony all share one canonical Public/Bundler
 * client surface. Per-module re-creation is a foot-gun (different RPC
 * endpoints = different state observation = silent inconsistency).
 *
 * Locked decisions:
 * - Chain: arbitrumSepolia (matches dashboard's RP-ID + ZeroDev project).
 * - PublicClient transport: env-pinned RPC (standard `eth_call` etc.),
 *   NOT the ZeroDev bundler — the bundler doesn't serve generic JSON-RPC
 *   reads (specifically `eth_getCode` returns the AA-stack codes, not
 *   the queried contract's; same gotcha the dashboard's `zerodev.provider.ts`
 *   solves at line 514 with `getViemClients()`).
 * - BundlerTransport: the ZeroDev bundler URL — only used by `createKernelAccountClient`.
 */

import {
  createPublicClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { arbitrumSepolia } from 'viem/chains';

function readEnv(name: string, fallback?: string): string {
  const v = import.meta.env?.[name as keyof ImportMetaEnv];
  if (typeof v === 'string' && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(
    `${name} not set in apps/checkout-pay/.env.stage — see .env.stage.example for the canonical shape.`,
  );
}

export function getBundlerUrl(): string {
  return readEnv('VITE_ZERODEV_BUNDLER_URL');
}

export function getPasskeyServerUrl(): string {
  return readEnv('VITE_ZERODEV_PASSKEY_SERVER_URL');
}

export function getRpcUrl(): string {
  return readEnv('VITE_RPC_URL', 'https://sepolia-rollup.arbitrum.io/rpc');
}

export function getChainId(): number {
  return Number(readEnv('VITE_CHAIN_ID', '421614'));
}

export function getUsdcAddress(): Address {
  return readEnv('VITE_USDC_ADDRESS') as Address;
}

export function getMuHavenStableAddress(): Address {
  return readEnv('VITE_MUHAVEN_STABLE_ADDRESS') as Address;
}

export function getSubscriptionAddress(): Address {
  return readEnv('VITE_SUBSCRIPTION_ADDRESS') as Address;
}

/**
 * Singleton `PublicClient` bound to the env RPC. Reused across the
 * P1 passkey ceremony + P2 balance poll + P3 ceremony so observation
 * is consistent.
 */
let _publicClient: PublicClient | null = null;

export function getPublicClient(): PublicClient {
  if (_publicClient) return _publicClient;
  _publicClient = createPublicClient({
    chain: arbitrumSepolia,
    transport: http(getRpcUrl()),
  });
  return _publicClient;
}

export const ARB_SEPOLIA_CHAIN = arbitrumSepolia;

export type { Address, Hex };
