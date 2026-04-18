// DEMO-ONLY: self-serve KYC whitelist endpoint. Signs `addToWhitelist` +
// `addToAccreditedList` on the ERC3643KYCAdapter with DEMO_WHITELIST_PRIVATE_KEY.
//
// KEY HYGIENE CAVEAT: The adapter has a single admin slot (onlyAdmin checks
// msg.sender == admin). Until the adapter is upgraded to multi-admin, this key
// MUST be the deployer key — which also owns MuHavenToken, YD + Escrow
// authorizedCallers, minter role, etc. Backend compromise = full platform
// takeover. Blast radius is labelled on the /login demo banner.
//
// Tracked in `development/DEV_WAVE_3/POST_HACKATHON.md` ("ERC3643KYCAdapter
// multi-admin upgrade") — ~2h fix that lets this endpoint run with a
// narrowly-scoped demo admin key.
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import { getEnv } from '../../../core/config.js';
import { ApplicationHttpError } from '../../../core/errors.js';
import { getLogger } from '../../../core/logger.js';

const KYC_ADAPTER_ABI = [
  {
    name: 'addToWhitelist',
    type: 'function',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'addToAccreditedList',
    type: 'function',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'isWhitelisted',
    type: 'function',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
  },
  {
    name: 'isAccredited',
    type: 'function',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
  },
] as const;

export interface WhitelistSelfResult {
  whitelisted: boolean;
  accredited: boolean;
  whitelistTxHash: string | null;
  accreditTxHash: string | null;
  alreadyComplete: boolean;
}

export class WhitelistSelfUseCase {
  private readonly logger = getLogger('WhitelistSelfUseCase');

  async execute(walletAddress: string): Promise<WhitelistSelfResult> {
    const env = getEnv();

    if (!env.DEMO_WHITELIST_PRIVATE_KEY) {
      throw new ApplicationHttpError(503, 'Demo whitelist endpoint disabled');
    }
    if (!env.KYC_ADAPTER_ADDRESS) {
      throw ApplicationHttpError.internalError('KYC_ADAPTER_ADDRESS not configured');
    }
    if (!env.RPC_URL) {
      throw ApplicationHttpError.internalError('RPC_URL not configured');
    }

    const kycAddress = env.KYC_ADAPTER_ADDRESS as `0x${string}`;
    const account = privateKeyToAccount(env.DEMO_WHITELIST_PRIVATE_KEY as Hex);
    const publicClient = createPublicClient({
      chain: arbitrumSepolia,
      transport: http(env.RPC_URL),
    });
    const walletClient = createWalletClient({
      account,
      chain: arbitrumSepolia,
      transport: http(env.RPC_URL),
    });

    const target = walletAddress as `0x${string}`;

    const [alreadyWhitelisted, alreadyAccredited] = await Promise.all([
      publicClient.readContract({
        address: kycAddress,
        abi: KYC_ADAPTER_ABI,
        functionName: 'isWhitelisted',
        args: [target],
      }),
      publicClient.readContract({
        address: kycAddress,
        abi: KYC_ADAPTER_ABI,
        functionName: 'isAccredited',
        args: [target],
      }),
    ]);

    if (alreadyWhitelisted && alreadyAccredited) {
      return {
        whitelisted: true,
        accredited: true,
        whitelistTxHash: null,
        accreditTxHash: null,
        alreadyComplete: true,
      };
    }

    let whitelistTxHash: `0x${string}` | null = null;
    if (!alreadyWhitelisted) {
      whitelistTxHash = await walletClient.writeContract({
        account,
        chain: arbitrumSepolia,
        address: kycAddress,
        abi: KYC_ADAPTER_ABI,
        functionName: 'addToWhitelist',
        args: [target],
      });
      this.logger.info({ walletAddress, txHash: whitelistTxHash }, 'addToWhitelist submitted');
      await publicClient.waitForTransactionReceipt({ hash: whitelistTxHash });
    }

    let accreditTxHash: `0x${string}` | null = null;
    if (!alreadyAccredited) {
      accreditTxHash = await walletClient.writeContract({
        account,
        chain: arbitrumSepolia,
        address: kycAddress,
        abi: KYC_ADAPTER_ABI,
        functionName: 'addToAccreditedList',
        args: [target],
      });
      this.logger.info({ walletAddress, txHash: accreditTxHash }, 'addToAccreditedList submitted');
      await publicClient.waitForTransactionReceipt({ hash: accreditTxHash });
    }

    return {
      whitelisted: true,
      accredited: true,
      whitelistTxHash,
      accreditTxHash,
      alreadyComplete: false,
    };
  }
}
