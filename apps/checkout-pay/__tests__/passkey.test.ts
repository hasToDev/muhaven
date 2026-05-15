/**
 * Wave 4 P5 (Wave-5 buyer-side port, P1) — passkey ceremony tests.
 *
 * The real ceremony goes through three external surfaces:
 *  - `navigator.credentials.get/create` (WebAuthn — OS-bound)
 *  - ZeroDev passkey server HTTP (`@zerodev/webauthn-key`)
 *  - ZeroDev bundler RPC (`@zerodev/sdk`)
 *
 * Vitest can't drive WebAuthn or hit live ZeroDev, so we mock the three
 * external boundaries via `vi.mock(...)` and assert the integration
 * shape: login-first, register-fallback-on-NotAllowedError, error
 * propagation, kernel-address surfacing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectOrCreate, PasskeyError } from '../src/passkey.js';
import { WebAuthnMode } from '@zerodev/webauthn-key';

const mockKernelAccount = {
  address: '0xfB5F227eF7a8Bdd852De0f621aA93FE4e80Ee020',
};
const mockKernelClient = {
  account: mockKernelAccount,
};

// Track the call sequence so we can assert login-vs-register flow.
const calls: Array<{ mode: WebAuthnMode; passkeyName: string }> = [];

vi.mock('@zerodev/webauthn-key', async () => {
  const actual = await vi.importActual<typeof import('@zerodev/webauthn-key')>(
    '@zerodev/webauthn-key',
  );
  return {
    ...actual,
    toWebAuthnKey: vi.fn(async (input: { mode: WebAuthnMode; passkeyName: string }) => {
      calls.push({ mode: input.mode, passkeyName: input.passkeyName });
      const config = (globalThis as unknown as { __passkeyTestConfig?: {
        loginThrows?: Error;
        registerThrows?: Error;
      } }).__passkeyTestConfig ?? {};
      if (input.mode === WebAuthnMode.Login && config.loginThrows) {
        throw config.loginThrows;
      }
      if (input.mode === WebAuthnMode.Register && config.registerThrows) {
        throw config.registerThrows;
      }
      return { mocked: 'webAuthnKey' } as unknown as Awaited<
        ReturnType<typeof actual.toWebAuthnKey>
      >;
    }),
  };
});

vi.mock('@zerodev/passkey-validator', () => ({
  toPasskeyValidator: vi.fn(async () => ({ mocked: 'passkeyValidator' })),
  PasskeyValidatorContractVersion: { V0_0_3_PATCHED: 'v003patched' as const },
}));

vi.mock('@zerodev/sdk', async () => {
  const actual = await vi.importActual<typeof import('@zerodev/sdk')>('@zerodev/sdk');
  return {
    ...actual,
    createKernelAccount: vi.fn(async () => mockKernelAccount),
    createKernelAccountClient: vi.fn(() => mockKernelClient),
    createZeroDevPaymasterClient: vi.fn(() => ({ mocked: 'paymaster' })),
  };
});

vi.mock('../src/chain.js', () => ({
  ARB_SEPOLIA_CHAIN: { id: 421614 },
  getBundlerUrl: () => 'https://stub-bundler.test',
  getPasskeyServerUrl: () => 'https://stub-passkeys.test',
  getPublicClient: () => ({ mocked: 'publicClient' }),
}));

function makeNotAllowedError(message = 'user cancelled'): Error {
  const err = new Error(message);
  err.name = 'NotAllowedError';
  return err;
}

function setConfig(config: { loginThrows?: Error; registerThrows?: Error }): void {
  (globalThis as unknown as { __passkeyTestConfig?: unknown }).__passkeyTestConfig = config;
}

beforeEach(() => {
  calls.length = 0;
  setConfig({});
});

afterEach(() => {
  setConfig({});
});

describe('connectOrCreate', () => {
  it('runs Login first on the happy path and surfaces the kernel address', async () => {
    const result = await connectOrCreate();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.mode).toBe(WebAuthnMode.Login);
    expect(result.address).toBe(mockKernelAccount.address);
    expect(result.newlyRegistered).toBe(false);
    expect(result.kernelClient).toBe(mockKernelClient);
  });

  it('falls back to Register when Login throws a non-cancel error', async () => {
    // Simulate ZeroDev passkey server returning "no credentials for RP-ID"
    // — surfaces as a generic Error (NOT a NotAllowedError). The Login
    // attempt fails, we proceed to Register.
    setConfig({ loginThrows: new Error('no credentials for this RP-ID') });
    const result = await connectOrCreate();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.mode).toBe(WebAuthnMode.Login);
    expect(calls[1]?.mode).toBe(WebAuthnMode.Register);
    expect(calls[1]?.passkeyName).toBe('MuHaven Buyer');
    expect(result.newlyRegistered).toBe(true);
  });

  it('uses a custom passkey name when provided', async () => {
    setConfig({ loginThrows: new Error('no creds') });
    await connectOrCreate('Custom Passkey');
    expect(calls[1]?.passkeyName).toBe('Custom Passkey');
  });

  it('falls through to Register when Login throws NotAllowedError (no-credential OR user-cancelled)', async () => {
    // 2026-05-17 behavior change: Chrome surfaces (a) no-credential
    // and (b) user-cancelled BOTH as `NotAllowedError`, so we cannot
    // distinguish them at the catch site. Falling through to Register
    // is the right call for new buyers; if the user genuinely meant
    // to cancel, they can cancel the Register dialog too (the next
    // test covers that branch).
    setConfig({ loginThrows: makeNotAllowedError() });
    const result = await connectOrCreate();
    expect(result.newlyRegistered).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.mode).toBe('login');
    expect(calls[1]?.mode).toBe('register');
  });

  it('throws PasskeyError(passkey_cancelled) when Register is user-cancelled', async () => {
    setConfig({
      loginThrows: new Error('no creds'),
      registerThrows: makeNotAllowedError(),
    });
    await expect(connectOrCreate()).rejects.toMatchObject({
      name: 'PasskeyError',
      code: 'passkey_cancelled',
    });
    expect(calls).toHaveLength(2);
  });

  it('throws PasskeyError(passkey_unavailable) on transport / infrastructure error', async () => {
    setConfig({
      loginThrows: new Error('no creds'),
      registerThrows: new Error('Passkey server 500'),
    });
    await expect(connectOrCreate()).rejects.toMatchObject({
      name: 'PasskeyError',
      code: 'passkey_unavailable',
    });
  });

  it('PasskeyError extends Error with a stable code surface', () => {
    const e = new PasskeyError('passkey_cancelled', 'test');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('PasskeyError');
    expect(e.code).toBe('passkey_cancelled');
    expect(e.message).toBe('test');
  });
});
