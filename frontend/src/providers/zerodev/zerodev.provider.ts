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
import {
  toPermissionValidator,
  serializePermissionAccount,
  deserializePermissionAccount,
} from '@zerodev/permissions';
import { toECDSASigner } from '@zerodev/permissions/signers';
import { toCallPolicy, CallPolicyVersion } from '@zerodev/permissions/policies';
import { toTimestampPolicy } from '@zerodev/permissions/policies';
import { createPublicClient, createWalletClient, http, toFunctionSelector, type Hex, type PublicClient } from 'viem';
import { signMessage as viemSignMessage } from 'viem/actions';
import { arbitrumSepolia } from 'viem/chains';
import { entryPoint07Address } from 'viem/account-abstraction';
import { WindowHelper } from '@/helpers/WindowHelper';
import { addresses as CONTRACTS } from '@/contracts/addresses';
import { yieldDistributorAbi, muhavenEscrowAbi, pusdcAbi } from '@/contracts/abis';
import {
  generateSessionRecord,
  loadSessionRecord,
  saveSessionRecord,
  clearSessionRecord,
  signerFromRecord,
  isRecordValid,
  expirySecondsRemaining,
  type SessionKeyRecord,
} from '../session-key';

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

/**
 * The narrow allowlist the session validator is scoped to.
 * Covers the two compounding flows: issuer distribute + investor claim.
 * Any UserOp targeting a contract/function outside this set will be
 * rejected by the bundler — we detect that and fall back to the passkey
 * kernel for the re-attempt.
 */
const SESSION_PERMISSIONS = [
  { target: CONTRACTS.yieldDistributor, functionName: 'startDistribution', abi: yieldDistributorAbi, valueLimit: 0n },
  { target: CONTRACTS.yieldDistributor, functionName: 'setEscrowIds', abi: yieldDistributorAbi, valueLimit: 0n },
  { target: CONTRACTS.yieldDistributor, functionName: 'processBatch', abi: yieldDistributorAbi, valueLimit: 0n },
  { target: CONTRACTS.muhavenEscrow, functionName: 'batchCreate', abi: muhavenEscrowAbi, valueLimit: 0n },
  { target: CONTRACTS.muhavenEscrow, functionName: 'redeem', abi: muhavenEscrowAbi, valueLimit: 0n },
  { target: CONTRACTS.muhavenEscrow, functionName: 'redeemMultiple', abi: muhavenEscrowAbi, valueLimit: 0n },
  { target: CONTRACTS.pusdc, functionName: 'setOperator', abi: pusdcAbi, valueLimit: 0n },
] as const;

/**
 * Pre-computed `${target}:${selector}` pairs for every entry in
 * SESSION_PERMISSIONS. Used by sendUserOperation to gate the session-kernel
 * path — calls outside this set skip the session install/retry entirely and
 * go straight to the passkey kernel. Without the gate every out-of-scope
 * UserOp triggers an unnecessary passkey prompt for the enableSig + a
 * guaranteed-failing bundler roundtrip before the fallback runs.
 */
const SESSION_SCOPE_KEYS = new Set<string>(
  SESSION_PERMISSIONS.map((perm) => {
    const abiItem = (perm.abi as readonly any[]).find(
      (item) => item.type === 'function' && item.name === perm.functionName,
    );
    if (!abiItem) throw new Error(`SESSION_PERMISSIONS: missing ABI for ${perm.functionName}`);
    const selector = toFunctionSelector(abiItem).toLowerCase();
    return `${perm.target.toLowerCase()}:${selector}`;
  }),
);

function isCallInSessionScope(call: Call): boolean {
  const data = (call.data ?? '0x') as Hex;
  if (data.length < 10) return false;
  const selector = data.slice(0, 10).toLowerCase();
  const target = (call.to as string).toLowerCase();
  return SESSION_SCOPE_KEYS.has(`${target}:${selector}`);
}

export class ZeroDevProvider implements IWalletProvider {
  private kernelClient: KernelAccountClient | null = null;
  private webAuthnKeyRef: WebAuthnKey | null = null;
  private _address: string | null = null;
  private _viemClients: ViemClients | null = null;

  // Session-key state — a second, scoped kernel client that signs silently
  // via an ECDSA private key held in sessionStorage. Built lazily on first
  // session-covered UserOp; torn down on disconnect or expiry.
  private sessionKernelClient: KernelAccountClient | null = null;
  private sessionExpiresAt = 0;
  private sessionRecord: SessionKeyRecord | null = null;
  // In-flight install guard. Concurrent sendUserOperation calls must not
  // race into two separate installSessionKey runs — doing so would fire
  // the enableSig passkey prompt twice and build orphaned kernels.
  private installPromise: Promise<void> | null = null;

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
    // Clear session-key state from both memory and sessionStorage.
    // On tab close sessionStorage is cleared anyway, but explicit logout
    // must not leave a valid session key behind on the device.
    if (this._address) {
      clearSessionRecord(this._address);
    }
    this.sessionKernelClient = null;
    this.sessionExpiresAt = 0;
    this.sessionRecord = null;
    this.installPromise = null;

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

  // ── Session keys ───────────────────────────────────────────────────

  hasSessionKey(): boolean {
    if (!this.sessionKernelClient) return false;
    return this.sessionExpiresAt > Math.floor(Date.now() / 1000);
  }

  getSessionExpirySeconds(): number {
    if (!this.sessionRecord) return 0;
    return expirySecondsRemaining(this.sessionRecord);
  }

  /**
   * Build (or restore) the scoped session kernel client.
   *
   * - If a valid session exists in sessionStorage, rebuild the kernel from it
   *   (no passkey prompt — enableSig is cached in `serializedAccount`).
   * - Otherwise generate a fresh session key + build a dual-validator kernel.
   *   The first UserOp sent through this kernel will fire the passkey prompt
   *   once to authorize the regular validator (that's the enableSig).
   *
   * Call site: invoked inside `sendUserOperation` on first session-covered
   * UserOp. Idempotent — reuses cached in-memory kernel when present, and
   * dedupes concurrent callers via `installPromise` so racing UserOps don't
   * fire two enableSig prompts.
   */
  async installSessionKey(): Promise<void> {
    if (this.hasSessionKey()) return;
    if (this.installPromise) return this.installPromise;

    this.installPromise = this.doInstallSessionKey();
    try {
      await this.installPromise;
    } finally {
      this.installPromise = null;
    }
  }

  private async doInstallSessionKey(): Promise<void> {
    if (!this.kernelClient?.account || !this.webAuthnKeyRef) {
      throw new Error('installSessionKey: passkey kernel not connected');
    }
    const smartAccountAddress = this.kernelClient.account.address;

    const stored = loadSessionRecord(smartAccountAddress);
    let record: SessionKeyRecord;
    if (isRecordValid(stored)) {
      record = stored;
    } else {
      const generated = generateSessionRecord(smartAccountAddress);
      record = generated.record;
      saveSessionRecord(record);
    }

    const publicClient = buildPublicClient();

    const sessionSigner = await toECDSASigner({ signer: signerFromRecord(record) });

    const callPolicy = toCallPolicy({
      policyVersion: CallPolicyVersion.V0_0_4,
      permissions: [...SESSION_PERMISSIONS] as any,
    });

    const timestampPolicy = toTimestampPolicy({
      validAfter: 0,
      validUntil: record.expiresAt,
    });

    const permissionValidator = await toPermissionValidator(publicClient, {
      signer: sessionSigner,
      policies: [callPolicy, timestampPolicy],
      kernelVersion: KERNEL_VERSION,
      entryPoint: ENTRY_POINT,
    });

    let account;
    if (record.serializedAccount) {
      account = await deserializePermissionAccount(
        publicClient as any,
        ENTRY_POINT,
        KERNEL_VERSION,
        record.serializedAccount,
        sessionSigner,
      );
    } else {
      const passkeyValidator = await toPasskeyValidator(publicClient, {
        webAuthnKey: this.webAuthnKeyRef,
        entryPoint: ENTRY_POINT,
        kernelVersion: KERNEL_VERSION,
        validatorContractVersion: PasskeyValidatorContractVersion.V0_0_3_PATCHED,
      });
      account = await createKernelAccount(publicClient as any, {
        plugins: { sudo: passkeyValidator, regular: permissionValidator },
        entryPoint: ENTRY_POINT,
        kernelVersion: KERNEL_VERSION,
      });
    }

    const paymaster = createZeroDevPaymasterClient({
      chain: arbitrumSepolia,
      transport: http(getBundlerUrl()),
    });

    this.sessionKernelClient = createKernelAccountClient({
      account,
      chain: arbitrumSepolia,
      bundlerTransport: http(getBundlerUrl()),
      paymaster,
    });
    this.sessionExpiresAt = record.expiresAt;
    this.sessionRecord = record;
  }

  /**
   * Cache the enableSig after the first successful session UserOp so the next
   * page load can reuse the same session without re-signing with the passkey.
   */
  private async persistSessionAfterFirstUserOp(): Promise<void> {
    if (!this.sessionKernelClient?.account) return;
    if (!this.sessionRecord || this.sessionRecord.serializedAccount) return;
    try {
      const serialized = await serializePermissionAccount(
        this.sessionKernelClient.account as any,
        this.sessionRecord.privateKey,
      );
      this.sessionRecord = { ...this.sessionRecord, serializedAccount: serialized };
      saveSessionRecord(this.sessionRecord);
    } catch (e) {
      // Non-fatal: reload will re-install cleanly.
      console.warn('[ZeroDev] serializePermissionAccount failed — session will re-install on reload', e);
    }
  }

  /**
   * Send a UserOperation. Prefers the scoped session kernel when every call
   * in the batch is covered by SESSION_PERMISSIONS; otherwise goes directly
   * to the passkey kernel. The legacy "try session, fall back on failure"
   * flow is retained as a safety net for covered-but-rejected ops (e.g.
   * session expired mid-flight).
   */
  async sendUserOperation(calls: Call[]): Promise<string> {
    if (!this.kernelClient?.account) throw new Error('Not connected');

    // Fast-path: any out-of-scope call → straight to passkey kernel.
    // Avoids an enableSig passkey prompt + a guaranteed-failing bundler
    // roundtrip (CallPolicy would revert InvalidCallData for anything not
    // in SESSION_PERMISSIONS).
    if (!calls.every(isCallInSessionScope)) {
      return this.sendViaKernel(this.kernelClient, calls);
    }

    try {
      if (!this.hasSessionKey()) {
        await this.installSessionKey();
      }
      const hash = await this.sendViaKernel(this.sessionKernelClient!, calls);
      // Non-blocking: persist enableSig for reload survival.
      void this.persistSessionAfterFirstUserOp();
      return hash;
    } catch (e) {
      console.warn('[ZeroDev] Session-key send failed; falling back to passkey kernel', e);
      // Invalidate the session so later calls retry cleanly.
      this.sessionKernelClient = null;
      this.sessionExpiresAt = 0;
      return this.sendViaKernel(this.kernelClient, calls);
    }
  }

  private async sendViaKernel(client: KernelAccountClient, calls: Call[]): Promise<string> {
    if (!client.account) throw new Error('Kernel client has no account');

    const callData = await client.account.encodeCalls(
      calls.map((c) => ({
        to: c.to as Hex,
        data: c.data as Hex,
        value: c.value ?? 0n,
      })),
    );

    const userOpHash = await client.sendUserOperation({ callData });
    const receipt = await client.waitForUserOperationReceipt({ hash: userOpHash });
    return receipt.receipt.transactionHash;
  }
}
