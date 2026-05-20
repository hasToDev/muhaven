/**
 * Wave 5 Q3 (v3.1 B.2) — Node-mode CoFHE client constructor.
 *
 * Mirrors the testnet branch of `tasks/utils.ts:createCofheClient` but
 * removes the hardhat coupling — the only hardhat-specific call there is
 * `hre.cofhe.hardhatSignerAdapter(signer)`, which is a thin wrapper that
 * derives viem `publicClient` + `walletClient` from a hardhat signer.
 * In the backend cron path we build those clients directly from an RPC
 * URL + private key, so no hardhat dependency is needed.
 *
 * Used by:
 *   - The shared `yield-epoch-runner.ts` (B.1) — encrypts `totalYield`
 *     as `Encryptable.uint128(...)` before `fundEpoch`.
 *   - Future Wave 5 Q3 `YieldDistributionCron` (A.4) — instantiated once
 *     per cron tick from `YIELD_CRON_PRIVATE_KEY`.
 *
 * @cofhe/sdk/node config shape confirmed against
 *   `node_modules/@cofhe/sdk/dist/clientTypes-DDmcgZ0a.d.ts:191-227`:
 *   `environment` defaults to `'node'`, `supportedChains` is required.
 *
 * Side effect: calls `client.permits.createSelf({issuer})` so the
 * connected account has a self-permit registered for any decrypt-for-view
 * paths. The cron's primary use is encrypt-only (fundEpoch), but the
 * runner doc-contract permits future read paths without re-wiring.
 */
import { createCofheConfig, createCofheClient as createCofheClientBase } from '@cofhe/sdk/node';
import { getChainById } from '@cofhe/sdk/chains';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';

export interface NodeCofheClientInput {
  rpcUrl: string;
  /** Arb Sepolia = 421614. Used to look up the CoFHE chain config. */
  chainId: number;
  privateKey: `0x${string}`;
}

export async function createNodeCofheClient(input: NodeCofheClientInput) {
  const chain = getChainById(input.chainId);
  if (!chain) {
    throw new Error(
      `No CoFHE chain configuration found for chainId ${input.chainId}. ` +
        `Supported chains exported from @cofhe/sdk/chains.`,
    );
  }

  // Only Arb Sepolia (421614) is supported today. Adding more chains
  // means adding a viem-chain lookup table here — keeping it explicit
  // avoids silently dispatching to the wrong viem chain config.
  if (input.chainId !== 421614) {
    throw new Error(
      `createNodeCofheClient only wired for Arb Sepolia (421614); got ${input.chainId}`,
    );
  }

  const account = privateKeyToAccount(input.privateKey);
  const publicClient = createPublicClient({
    chain: arbitrumSepolia,
    transport: http(input.rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain: arbitrumSepolia,
    transport: http(input.rpcUrl),
  });

  const config = createCofheConfig({
    environment: 'node',
    supportedChains: [chain],
  });
  const client = createCofheClientBase(config);
  // `as any` bridges a known viem-version mismatch — backend's viem !=
  // @cofhe/sdk's pinned viem peer dep, so the PublicClient/WalletClient
  // shapes are nominally different despite being identical at runtime.
  // Same workaround pattern used by `nav-cron.ts` and `tasks/utils.ts`.
  await client.connect(publicClient as any, walletClient as any);
  await client.permits.createSelf({ issuer: account.address });
  return client;
}
