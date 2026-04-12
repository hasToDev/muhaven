import type { IWalletProvider, Call, ViemClients } from '../wallet-provider.interface';
import { toWebAuthnKey, WebAuthnMode, type WebAuthnKey } from '@zerodev/webauthn-key';
import { toPasskeyValidator, PasskeyValidatorContractVersion } from '@zerodev/passkey-validator';
import {
  createKernelAccount,
  createKernelAccountClient,
  createZeroDevPaymasterClient,
  constants,
} from '@zerodev/sdk';
import type { KernelAccountClient } from '@zerodev/sdk';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { signMessage as viemSignMessage } from 'viem/actions';
import { arbitrumSepolia } from 'viem/chains';
import { entryPoint07Address } from 'viem/account-abstraction';
import { WindowHelper } from '@/helpers/WindowHelper';

const ENTRY_POINT = { address: entryPoint07Address, version: '0.7' as const };
const KERNEL_VERSION = constants.KERNEL_V3_1;

function getBundlerUrl(): string {
  const url = import.meta.env.VITE_ZERODEV_BUNDLER_URL;
  if (!url) throw new Error('VITE_ZERODEV_BUNDLER_URL not set');
  return url;
}

function getPasskeyServerUrl(): string {
  const url = import.meta.env.VITE_ZERODEV_PASSKEY_SERVER_URL;
  if (!url) throw new Error('VITE_ZERODEV_PASSKEY_SERVER_URL not set');
  return url;
}

function buildPublicClient() {
  return createPublicClient({
    chain: arbitrumSepolia,
    transport: http(getBundlerUrl()),
  });
}

async function buildKernelClient(webAuthnKey: WebAuthnKey): Promise<KernelAccountClient> {
  const publicClient = buildPublicClient();
  const bundlerUrl = getBundlerUrl();

  const passkeyValidator = await toPasskeyValidator(publicClient, {
    webAuthnKey,
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_VERSION,
    validatorContractVersion: PasskeyValidatorContractVersion.V0_0_3_PATCHED,
  });

  const account = await createKernelAccount(publicClient, {
    plugins: { sudo: passkeyValidator },
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_VERSION,
  });

  const paymaster = createZeroDevPaymasterClient({
    chain: arbitrumSepolia,
    transport: http(bundlerUrl),
  });

  return createKernelAccountClient({
    account,
    chain: arbitrumSepolia,
    bundlerTransport: http(bundlerUrl),
    paymaster,
  });
}

function getRpcUrl(): string {
  return import.meta.env.VITE_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc';
}

export class ZeroDevProvider implements IWalletProvider {
  private kernelClient: KernelAccountClient | null = null;
  private webAuthnKeyRef: WebAuthnKey | null = null;
  private _address: string | null = null;
  private _viemClients: ViemClients | null = null;

  async connect(): Promise<string> {
    return this.login();
  }

  async register(username: string): Promise<string> {
    await WindowHelper.ensureFocus();

    const webAuthnKey = await toWebAuthnKey({
      passkeyName: username,
      passkeyServerUrl: getPasskeyServerUrl(),
      mode: WebAuthnMode.Register,
    });

    this.kernelClient = await buildKernelClient(webAuthnKey);
    this.webAuthnKeyRef = webAuthnKey;

    if (!this.kernelClient.account) {
      throw new Error('Kernel account not found after registration');
    }

    this._address = this.kernelClient.account.address;
    return this._address;
  }

  private async login(): Promise<string> {
    await WindowHelper.ensureFocus();

    const webAuthnKey = await toWebAuthnKey({
      passkeyName: '',
      passkeyServerUrl: getPasskeyServerUrl(),
      mode: WebAuthnMode.Login,
    });

    this.kernelClient = await buildKernelClient(webAuthnKey);
    this.webAuthnKeyRef = webAuthnKey;

    if (!this.kernelClient.account) {
      throw new Error('Kernel account not found after login');
    }

    this._address = this.kernelClient.account.address;
    return this._address;
  }

  async disconnect(): Promise<void> {
    this.kernelClient = null;
    this.webAuthnKeyRef = null;
    this._address = null;
    this._viemClients = null;
  }

  async signMessage(message: string): Promise<string> {
    if (!this.kernelClient?.account) throw new Error('Not connected');
    await WindowHelper.ensureFocus();
    return viemSignMessage(this.kernelClient, {
      account: this.kernelClient.account,
      message,
    });
  }

  getAddress(): string | null {
    return this._address;
  }

  isConnected(): boolean {
    return this._address !== null && this.kernelClient !== null;
  }

  getViemClients(): ViemClients | null {
    if (!this.kernelClient?.account) return null;
    if (this._viemClients) return this._viemClients;

    // Use standard RPC for publicClient (not the bundler URL) —
    // the cofhe SDK needs standard eth_call, eth_getCode, etc.
    const publicClient = createPublicClient({
      chain: arbitrumSepolia,
      transport: http(getRpcUrl()),
    });

    // Create a wallet client backed by the kernel account's signing capability
    const walletClient = createWalletClient({
      account: this.kernelClient.account,
      chain: arbitrumSepolia,
      transport: http(getRpcUrl()),
    });

    this._viemClients = { publicClient, walletClient };
    return this._viemClients;
  }

  async sendUserOperation(calls: Call[]): Promise<string> {
    if (!this.kernelClient?.account) throw new Error('Not connected');

    const callData = await this.kernelClient.account.encodeCalls(
      calls.map((c) => ({
        to: c.to as Hex,
        data: c.data as Hex,
        value: c.value ?? 0n,
      })),
    );

    const userOpHash = await this.kernelClient.sendUserOperation({ callData });
    const receipt = await this.kernelClient.waitForUserOperationReceipt({ hash: userOpHash });
    return receipt.receipt.transactionHash;
  }
}
