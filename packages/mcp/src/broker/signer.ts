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
}
