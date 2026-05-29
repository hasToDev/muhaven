import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-chars-long';
});

/**
 * Wave 5 Slice 2c regression guard. The `OnChainReinvestGateReader` module
 * runs a top-level `parseAbi([...])` at import time — a malformed human-
 * readable ABI string (e.g. the `tuple(...)` keyword, which viem's
 * human-readable parser REJECTS — it wants `(...)`) throws on import and
 * crash-loops the backend at BOOT (container imports it via the DI
 * container). That exact bug shipped in 2b and only surfaced on the first
 * prod deploy. This test imports + constructs the reader so any future ABI
 * typo fails here instead of in production.
 */
describe('OnChainReinvestGateReader — boot-time ABI parse', () => {
  it('imports + constructs without throwing (top-level parseAbi is valid)', async () => {
    const mod = await import('../reinvest-gate.reader.js');
    expect(typeof mod.OnChainReinvestGateReader).toBe('function');
    // Constructing exercises createPublicClient; the load-bearing assertion
    // is that the module-level parseAbi didn't throw on import.
    const reader = new mod.OnChainReinvestGateReader({ rpcUrl: 'https://example.invalid' });
    expect(reader).toBeTruthy();
    expect(typeof reader.findClaimableEpochs).toBe('function');
  });
});
