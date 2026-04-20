// DEMO-ONLY: self-serve KYC whitelist endpoint. Signs `addToWhitelist` +
// `addToAccreditedList` on the ERC3643KYCAdapter AND `grantMinter` on
// MuHavenToken, all with DEMO_WHITELIST_PRIVATE_KEY.
//
// The grantMinter call is a demo shortcut. In production (Wave 3.5) investors
// never hold MINTER_ROLE — MuHavenSubscription holds it and mints atomically
// against PUSDC payment. For the current hackathon build the DepositPage
// "Encrypted Mint" path calls MuHavenToken.mint directly from the investor's
// kernel, which requires the kernel be in the `minters` mapping. This endpoint
// puts it there. See PRODUCTION_DESIGN/ARCHITECTURE.md for the target flow.
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

const MUHAVEN_TOKEN_MINTER_ABI = [
  {
    name: 'grantMinter',
    type: 'function',
    inputs: [{ name: 'minter', type: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'minters',
    type: 'function',
    inputs: [{ name: '', type: 'address' }],
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
  // Demo shortcut: investor-granted MINTER_ROLE on MuHavenToken so
  // DepositPage encrypted-mint works. In production this field is removed;
  // Subscription contract holds MINTER_ROLE and investors never do.
  minterGranted: boolean;
  minterTxHash: string | null;
  minterError: string | null;
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
    const tokenAddress = env.MUHAVEN_TOKEN_ADDRESS as `0x${string}` | undefined;

    const [alreadyWhitelisted, alreadyAccredited, alreadyMinter] = await Promise.all([
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
      tokenAddress
        ? publicClient.readContract({
            address: tokenAddress,
            abi: MUHAVEN_TOKEN_MINTER_ABI,
            functionName: 'minters',
            args: [target],
          })
        : Promise.resolve(false),
    ]);

    if (alreadyWhitelisted && alreadyAccredited && alreadyMinter) {
      return {
        whitelisted: true,
        accredited: true,
        whitelistTxHash: null,
        accreditTxHash: null,
        alreadyComplete: true,
        minterGranted: true,
        minterTxHash: null,
        minterError: null,
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

    // Demo shortcut: grant MINTER_ROLE so investor kernel can call
    // MuHavenToken.mint directly from DepositPage. Tolerant of failure —
    // if this fails the investor can still use MuHavenVault.wrap.
    let minterTxHash: `0x${string}` | null = null;
    let minterGranted = alreadyMinter;
    let minterError: string | null = null;
    if (!tokenAddress) {
      minterError = 'MUHAVEN_TOKEN_ADDRESS not configured';
      this.logger.warn({ walletAddress }, 'skipping grantMinter: MUHAVEN_TOKEN_ADDRESS not configured');
    } else if (!alreadyMinter) {
      try {
        minterTxHash = await walletClient.writeContract({
          account,
          chain: arbitrumSepolia,
          address: tokenAddress,
          abi: MUHAVEN_TOKEN_MINTER_ABI,
          functionName: 'grantMinter',
          args: [target],
        });
        this.logger.info({ walletAddress, txHash: minterTxHash }, 'grantMinter submitted');
        await publicClient.waitForTransactionReceipt({ hash: minterTxHash });
        minterGranted = true;
      } catch (err) {
        minterError = err instanceof Error ? err.message : String(err);
        this.logger.error({ walletAddress, err: minterError }, 'grantMinter failed; investor can still use vault wrap');
      }
    }

    return {
      whitelisted: true,
      accredited: true,
      whitelistTxHash,
      accreditTxHash,
      alreadyComplete: false,
      minterGranted,
      minterTxHash,
      minterError,
    };
  }
}
