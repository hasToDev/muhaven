/**
 * IssuerOracleNavWriterService — boot-time assertions + input guards.
 *
 * The setNAV path itself is exercised end-to-end by the wizard step-6
 * walkthrough (operator-driven) since it spins viem clients + writes
 * to chain. These unit tests cover the construct-time invariants that
 * keep the service from being misconfigured silently — those are pure
 * synchronous checks that don't need an RPC.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  IssuerOracleNavWriterService,
  type IssuerOracleNavWriterConfig,
} from '../issuer-oracle-nav-writer.service.js';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import type { Address, Hex } from 'viem';

const VALID_ORACLE = ('0x' + '11'.repeat(20)) as Address;

function makeKey(): Hex {
  return generatePrivateKey();
}

function makeConfig(overrides: Partial<IssuerOracleNavWriterConfig> = {}): IssuerOracleNavWriterConfig {
  const key = overrides.navWriterPrivateKey ?? makeKey();
  const expected = overrides.expectedNavWriterAddress ?? privateKeyToAccount(key).address;
  return {
    rpcUrl: 'http://localhost:8545',
    navWriterPrivateKey: key,
    expectedNavWriterAddress: expected,
    issuerOracleAddress: VALID_ORACLE,
    ...overrides,
  } as IssuerOracleNavWriterConfig;
}

describe('IssuerOracleNavWriterService — construct-time guards', () => {
  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret-that-is-at-least-32-chars-long';
    process.env.JWT_ISSUER = 'test-issuer';
  });

  it('constructs cleanly when derived signer == expected navWriter', () => {
    expect(() => new IssuerOracleNavWriterService(makeConfig())).not.toThrow();
  });

  it('rejects malformed expectedNavWriterAddress (not 0x[40-hex])', () => {
    expect(() =>
      new IssuerOracleNavWriterService(
        makeConfig({ expectedNavWriterAddress: '0xnothex' as Address }),
      ),
    ).toThrow(/expectedNavWriterAddress is not a 0x-prefixed 20-byte hex/);
  });

  it('rejects malformed issuerOracleAddress (not 0x[40-hex])', () => {
    expect(() =>
      new IssuerOracleNavWriterService(
        makeConfig({ issuerOracleAddress: '0xinvalid' as Address }),
      ),
    ).toThrow(/issuerOracleAddress is not a 0x-prefixed 20-byte hex/);
  });

  it('rejects when derived signer != expected navWriter', () => {
    const keyA = makeKey();
    const expectedB = privateKeyToAccount(makeKey()).address; // Different EOA
    expect(() =>
      new IssuerOracleNavWriterService(
        makeConfig({ navWriterPrivateKey: keyA, expectedNavWriterAddress: expectedB }),
      ),
    ).toThrow(/PLATFORM_DEPLOYER_PRIVATE_KEY derives .* but PLATFORM_NAV_WRITER_ADDRESS is/);
  });

  it('mismatch error names the offending values (lowercased)', () => {
    const keyA = makeKey();
    const expectedB = privateKeyToAccount(makeKey()).address;
    try {
      new IssuerOracleNavWriterService(
        makeConfig({ navWriterPrivateKey: keyA, expectedNavWriterAddress: expectedB }),
      );
      throw new Error('expected throw');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const derivedAddr = privateKeyToAccount(keyA).address.toLowerCase();
      expect(msg).toContain(derivedAddr);
      expect(msg).toContain(expectedB.toLowerCase());
    }
  });
});

describe('IssuerOracleNavWriterService.setNAV — input guards', () => {
  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret-that-is-at-least-32-chars-long';
    process.env.JWT_ISSUER = 'test-issuer';
  });

  it('refuses zero NAV (Oracle would revert ZeroNAV)', async () => {
    const svc = new IssuerOracleNavWriterService(makeConfig());
    await expect(svc.setNAV(VALID_ORACLE, 0n)).rejects.toThrow(/newNav must be > 0/);
  });

  it('refuses negative NAV', async () => {
    const svc = new IssuerOracleNavWriterService(makeConfig());
    await expect(svc.setNAV(VALID_ORACLE, -1n)).rejects.toThrow(/newNav must be > 0/);
  });
});
