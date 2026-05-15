/**
 * 2026-05-17 Design A · PREVENTION — server-side NAV writer for the
 * self-serve issuer-onboarding wizard's step 6.
 *
 * `IssuerControlledOracle.setNAV` is `onlyNavWriter`-gated; since
 * Design A every onboarded token registers the platform's signer as
 * `navWriter` (instead of the applicant kernel), the wizard step-6
 * setNAV call moves server-side. The applicant kernel only signs the
 * follow-up `TokenRegistry.setPaused(false)`.
 *
 * Boot-time assertion: the signer derived from `PLATFORM_DEPLOYER_PRIVATE_KEY`
 * MUST equal `PLATFORM_NAV_WRITER_ADDRESS`. If they diverge, the service
 * refuses to construct — `ProposeUnpauseTokenToolUseCase` falls back to
 * a 503 and the operator runbook surfaces the misconfig.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import { getLogger } from '../../core/logger.js';

export interface IssuerOracleNavWriteResult {
  txHash: Hex;
}

export interface IIssuerOracleNavWriter {
  setNAV(token: Address, newNav: bigint): Promise<IssuerOracleNavWriteResult>;
}

export interface IssuerOracleNavWriterConfig {
  rpcUrl: string;
  /** 0x-prefixed 32-byte hex of the platform's NAV writer EOA. */
  navWriterPrivateKey: Hex;
  /** Public address that must match `navWriterPrivateKey` and the on-chain registered navWriter. */
  expectedNavWriterAddress: Address;
  /** `IssuerControlledOracle` proxy address. */
  issuerOracleAddress: Address;
}

const ORACLE_NAV_WRITER_ABI: Abi = [
  {
    type: 'function',
    name: 'setNAV',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'newNAV', type: 'uint256' },
    ],
    outputs: [],
  },
];

export class IssuerOracleNavWriterService implements IIssuerOracleNavWriter {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly signerAccount: ReturnType<typeof privateKeyToAccount>;
  private readonly issuerOracleAddress: Address;
  // Lazy logger: avoid touching `getEnv()` at module load, since unit
  // tests instantiate this service before priming JWT_SECRET et al.
  private _logger: ReturnType<typeof getLogger> | null = null;
  private get logger(): ReturnType<typeof getLogger> {
    if (!this._logger) this._logger = getLogger('IssuerOracleNavWriterService');
    return this._logger;
  }

  constructor(config: IssuerOracleNavWriterConfig) {
    // Defense-in-depth: container already regex-checks shapes, but
    // construct-time validation keeps direct-instantiation (tests,
    // future callers) honest. `privateKeyToAccount` will throw on a
    // malformed key; we add address shape checks so the resulting
    // error mentions the OFFENDING value.
    if (!/^0x[0-9a-fA-F]{40}$/.test(config.expectedNavWriterAddress)) {
      throw new Error(
        `IssuerOracleNavWriterService: expectedNavWriterAddress is not a 0x-prefixed 20-byte hex: ${config.expectedNavWriterAddress}`,
      );
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(config.issuerOracleAddress)) {
      throw new Error(
        `IssuerOracleNavWriterService: issuerOracleAddress is not a 0x-prefixed 20-byte hex: ${config.issuerOracleAddress}`,
      );
    }
    this.signerAccount = privateKeyToAccount(config.navWriterPrivateKey);
    const derived = this.signerAccount.address.toLowerCase();
    const expected = config.expectedNavWriterAddress.toLowerCase();
    if (derived !== expected) {
      throw new Error(
        `IssuerOracleNavWriterService: PLATFORM_DEPLOYER_PRIVATE_KEY derives ${derived} ` +
          `but PLATFORM_NAV_WRITER_ADDRESS is ${expected}. The server-side setNAV signer ` +
          `must equal the on-chain registered navWriter — fix the env and restart.`,
      );
    }
    this.publicClient = createPublicClient({
      chain: arbitrumSepolia,
      transport: http(config.rpcUrl),
    });
    this.walletClient = createWalletClient({
      account: this.signerAccount,
      chain: arbitrumSepolia,
      transport: http(config.rpcUrl),
    });
    this.issuerOracleAddress = config.issuerOracleAddress;
  }

  async setNAV(token: Address, newNav: bigint): Promise<IssuerOracleNavWriteResult> {
    if (newNav <= 0n) {
      throw new Error('setNAV: newNav must be > 0 (Oracle reverts ZeroNAV)');
    }
    const txHash = await this.walletClient.writeContract({
      account: this.signerAccount,
      chain: arbitrumSepolia,
      address: this.issuerOracleAddress,
      abi: ORACLE_NAV_WRITER_ABI,
      functionName: 'setNAV',
      args: [token, newNav],
    });
    this.logger.info({ token, newNav: newNav.toString(), txHash }, 'setNAV submitted');
    // `waitForTransactionReceipt` returns the receipt for both success
    // and reverted txs (it does NOT throw on revert). viem's pre-submit
    // simulation usually catches reverts before we reach this branch,
    // but a sim-passed-then-mined-as-reverted race is possible (e.g.
    // someone else's tx in the same block changing navWriter). Guard
    // explicitly so the caller doesn't silently treat a reverted setNAV
    // as success.
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') {
      throw new Error(
        `setNAV mined as reverted (status=${receipt.status}, txHash=${txHash}, token=${token})`,
      );
    }
    return { txHash };
  }
}
