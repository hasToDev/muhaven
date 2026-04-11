/**
 * Static fallback rates — last resort when primary and on-chain sources fail.
 * Values are reasonable defaults based on market data as of April 2026.
 */

export interface FallbackRate {
  nav: number;
  apy: number;
  source: string;
}

const FALLBACK_RATES: Record<string, FallbackRate> = {
  // MHTB — Treasury Bond (tracks 3-month T-bill)
  '0x0000000000000000000000000000000000000001': {
    nav: 1.0,
    apy: 4.3,
    source: 'static_fallback',
  },
  // MHMM — Money Market (tracks SOFR)
  '0x0000000000000000000000000000000000000002': {
    nav: 1.043,
    apy: 4.3,
    source: 'static_fallback',
  },
  // BUIDL — BlackRock USD Institutional Digital Liquidity Fund
  '0x0000000000000000000000000000000000000003': {
    nav: 1.0,
    apy: 5.0,
    source: 'static_fallback',
  },
  // USDY — Ondo US Dollar Yield
  '0x0000000000000000000000000000000000000004': {
    nav: 1.052,
    apy: 5.2,
    source: 'static_fallback',
  },
  // MH10Y — 10-Year Treasury Note
  '0x0000000000000000000000000000000000000005': {
    nav: 1.0,
    apy: 4.5,
    source: 'static_fallback',
  },
  // MHIG — Investment Grade Corporate Bond
  '0x0000000000000000000000000000000000000006': {
    nav: 1.0,
    apy: 4.8,
    source: 'static_fallback',
  },
  // MHHY — High Yield Corporate Bond
  '0x0000000000000000000000000000000000000007': {
    nav: 1.0,
    apy: 7.5,
    source: 'static_fallback',
  },
  // MHRE — Real Estate (tracks 30-year mortgage rate)
  '0x0000000000000000000000000000000000000008': {
    nav: 1.0,
    apy: 6.5,
    source: 'static_fallback',
  },
};

export function getFallbackRate(tokenAddress: string): FallbackRate | null {
  return FALLBACK_RATES[tokenAddress.toLowerCase()] ?? null;
}
