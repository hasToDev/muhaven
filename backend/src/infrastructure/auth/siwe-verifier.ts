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

      logger.info({
        address,
        nonce: siweMessage.nonce,
        chainId: siweMessage.chainId,
        domain: siweMessage.domain,
        uri: siweMessage.uri,
      }, 'Verifying SIWE signature');

      const client = this.getPublicClient();

      // Check if the smart account has code deployed
      const code = await client.getCode({ address });
      const isDeployed = code !== undefined && code !== '0x';
      logger.info({ address, isDeployed, codeLength: code?.length ?? 0 }, 'Smart account deployment status');

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
      const errMsg = error instanceof Error ? error.message : String(error);
      const errStack = error instanceof Error ? error.stack : undefined;
      logger.error({ error: errMsg, stack: errStack }, 'SIWE verification failed');
      return { address: '', valid: false };
    }
  }
}
