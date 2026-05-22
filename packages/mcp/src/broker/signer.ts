/**
 * Thin wrapper around viem's privateKeyToAccount. Keeps the rest of the
 * broker free of viem types so the IPC layer can be tested without
 * pulling viem into the test-runtime resolution graph.
 *
 * The on-chain UserOp submission is the frontend / dashboard's job in
 * Wave 4 (P6 wires it for the policy-engine cron path). The broker's
 * single responsibility is to ECDSA-sign a hash — never to issue an
 * RPC, never to construct an unsigned UserOp, never to read an Arb
 * RPC endpoint. That isolation is the lethal-trifecta mitigation.
 */

import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

export interface ISigner {
  readonly address: `0x${string}`;
  signHash(hash: `0x${string}`): Promise<`0x${string}`>;
  /**
   * Wave 5 Path D Slice 1 Commit 3.5 — EIP-191 personal-sign over a
   * raw 32-byte hash. ZeroDev's permission validator on Kernel v3.1
   * (via `@zerodev/permissions::signUserOperation`) does
   * `signer.account.signMessage({ message: { raw: userOpHash } })` —
   * i.e., it ECDSA-signs `keccak256("\x19Ethereum Signed Message:\n32"
   * || userOpHash)`, NOT the raw userOpHash. For Path D autonomous
   * UserOps, the broker MUST sign via this path or the on-chain
   * `ecrecover` yields a different address → `AA24 InvalidSigner`.
   *
   * `signHash` (raw ECDSA over the supplied hash) stays for back-compat
   * with `sign_hash` IPC verb / Wave 4 placeholder envelope; the new
   * `signRawMessage` is the verb Path D's `sign_userop` daemon path
   * calls.
   */
  signRawMessage(hash: `0x${string}`): Promise<`0x${string}`>;
}

/**
 * Sentinel signer for the read-only daemon posture (no
 * `MUHAVEN_BROKER_SESSION_KEY` at boot). `address` returns the zero
 * address; `signHash` throws `MissingSessionKeyError`, which the daemon
 * maps to a structured `session_key_unavailable` broker error response.
 *
 * Closes §3e⁶ F-broker-session-key-required-for-reads — the daemon can
 * serve `hello` + JWT verbs for read paths without an on-chain signer.
 */
export class MissingSessionKeyError extends Error {
  constructor() {
    super(
      'session_key_unavailable: daemon booted in read-only posture (no ' +
        'MUHAVEN_BROKER_SESSION_KEY at env-load time). Mint a session key via ' +
        'the dashboard /agent/policy/transition flow, set MUHAVEN_BROKER_SESSION_KEY, ' +
        'and restart the daemon. (Note: `muhaven-broker login` mints a JWT, ' +
        'NOT a session key — do not loop on that command for this error.)',
    );
    this.name = 'MissingSessionKeyError';
  }
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export class NullSigner implements ISigner {
  readonly address = ZERO_ADDRESS;
  async signHash(_hash: `0x${string}`): Promise<`0x${string}`> {
    throw new MissingSessionKeyError();
  }
  async signRawMessage(_hash: `0x${string}`): Promise<`0x${string}`> {
    throw new MissingSessionKeyError();
  }
}

export class ViemSigner implements ISigner {
  private readonly account: PrivateKeyAccount;

  constructor(privateKey: `0x${string}`) {
    this.account = privateKeyToAccount(privateKey);
  }

  get address(): `0x${string}` {
    return this.account.address;
  }

  async signHash(hash: `0x${string}`): Promise<`0x${string}`> {
    // viem's signMessage with a raw bytes body produces an EIP-191 signature;
    // for a precomputed hash (e.g., the UserOp hash) we need the raw
    // ECDSA signature without the EIP-191 prefix. `account.sign({ hash })`
    // is the right primitive — it ECDSA-signs the digest as-is.
    return this.account.sign({ hash });
  }

  async signRawMessage(hash: `0x${string}`): Promise<`0x${string}`> {
    // ZeroDev's permission validator (`@zerodev/permissions::signUserOperation`
    // on Kernel v3.1) signs the userOpHash via
    //   signer.account.signMessage({ message: { raw: userOpHash } })
    // which prepends `"\x19Ethereum Signed Message:\n32"` to the hash and
    // ECDSA-signs the resulting digest. The on-chain ECDSAValidator
    // ecrecovers against the same EIP-191 envelope — so a raw `signHash`
    // here would yield a signer that doesn't match the installed validator
    // and `AA24 InvalidSigner` would fire on every submit.
    return this.account.signMessage({ message: { raw: hash } });
  }
}
