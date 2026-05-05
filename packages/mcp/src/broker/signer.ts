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
