import { SiweMessage } from 'siwe';
import { createPublicClient, http } from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import { getEnv } from '../../core/config.js';
import { getLogger } from '../../core/logger.js';

const logger = getLogger('SiweVerifier');

export class SiweVerifier {
  private publicClient: ReturnType<typeof createPublicClient> | null = null;

  private getPublicClient(): ReturnType<typeof createPublicClient> {
    if (!this.publicClient) {
      const rpcUrl = getEnv().RPC_URL || undefined;
      if (!rpcUrl) {
        logger.warn('RPC_URL not set — ERC-1271/ERC-6492 verification will fail for smart accounts (ZeroDev passkeys)');
      }
      this.publicClient = createPublicClient({
        chain: arbitrumSepolia,
        transport: http(rpcUrl),
      });
    }
    return this.publicClient;
  }

  async verify(message: string, signature: string): Promise<{ address: string; valid: boolean }> {
    try {
      const siweMessage = new SiweMessage(message);
      const address = siweMessage.address as `0x${string}`;

      logger.info({ address, nonce: siweMessage.nonce, chainId: siweMessage.chainId }, 'Verifying SIWE signature');

      const client = this.getPublicClient();

      // viem's verifyMessage handles both EOA (ecrecover) and smart account
      // (ERC-1271 isValidSignature + ERC-6492 counterfactual) signatures
      const valid = await client.verifyMessage({
        address,
        message,
        signature: signature as `0x${string}`,
      });

      logger.info({ address, valid }, 'SIWE verification result');
      return { address: siweMessage.address, valid };
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : error }, 'SIWE verification failed');
      return { address: '', valid: false };
    }
  }
}
