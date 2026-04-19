/**
 * Centralized external URLs + chain explorer helpers.
 * Keep all third-party links in one place so they can be swapped per network
 * (e.g. arbiscan.io vs sepolia.arbiscan.io) and audited from a single file.
 */

export const CIRCLE_FAUCET_URL = 'https://faucet.circle.com/'
export const ARBISCAN_BASE = 'https://sepolia.arbiscan.io'

export function arbiscanTx(hash: string): string {
  return `${ARBISCAN_BASE}/tx/${hash}`
}

export function arbiscanAddress(addr: string): string {
  return `${ARBISCAN_BASE}/address/${addr}`
}
