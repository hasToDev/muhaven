import type {
  IWalletProvider,
  Call,
  ViemClients,
  ExportedSessionKey,
  InstallScopedSessionInput,
  ScopedSessionInstallResult,
} from '../wallet-provider.interface';
import { privateKeyToAccount } from 'viem/accounts';
import { toWebAuthnKey, WebAuthnMode, type WebAuthnKey } from '@zerodev/webauthn-key';
import { toPasskeyValidator, PasskeyValidatorContractVersion } from '@zerodev/passkey-validator';
import {
  createKernelAccount,
  createKernelAccountClient,
  createZeroDevPaymasterClient,
  constants,
  getKernelV3Nonce,
  getActionSelector,
  getPluginsEnableTypedData,
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
import {
  createPublicClient,
  createWalletClient,
  http,
  zeroAddress,
  type Hex,
  type PublicClient,
} from 'viem';
import { signMessage as viemSignMessage } from 'viem/actions';
import { arbitrumSepolia } from 'viem/chains';
import { entryPoint07Address } from 'viem/account-abstraction';
import { WindowHelper } from '@/helpers/WindowHelper';
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
// Wave 5 Option D · Commit 1 (D-1) — extract the on-chain CallPolicy
// allowlists into their own pure module so the Scoped-tier validator
// (broad ex-transfer) and the legacy session-key validator (broader)
// build from a shared source-of-truth.
import {
  SESSION_PERMISSIONS,
  SCOPED_AUTONOMOUS_PERMISSIONS,
  isCallInSessionScope as isCallInSessionScopeFromModule,
} from './scoped-permissions';

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

// Wave 5 Option D · Commit 1 — `isCallInSessionScope` re-exported from
// `./scoped-permissions` for the in-tab legacy session-key gate. Other
// allowlist constants flow in via the import block at the top of this
// file.
const isCallInSessionScope = isCallInSessionScopeFromModule;

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
  // In-flight first-session-userOp guard. The kernel SDK fires the
  // enableSig WebAuthn ceremony lazily inside `prepareUserOperation` of
  // the first post-install userOp, NOT during `installSessionKey` itself.
  // Concurrent first-time sends therefore both trigger WebAuthn and abort
  // each other (only one auth ceremony can be outstanding per origin).
  // This promise resolves once the first sender has both landed its
  // userOp AND persisted the enableSig into `serializedAccount` — at
  // which point follower userOps use the rebuilt post-enable kernel and
  // can run in parallel without WebAuthn.
  private firstSessionOpPromise: Promise<void> | null = null;

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
    this.invalidateSession();
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
   * Wave 4 Q1 — surface the session-key private half for one-time install
   * on the operator's broker machine (via `muhaven-broker update --session
   * <key>`, or pasting into `MUHAVEN_BROKER_SESSION_KEY`).
   *
   * Behaviour:
   *   - If a valid in-memory `sessionRecord` exists, return its key.
   *   - Otherwise call `installSessionKey()` to mint a fresh record + build
   *     the scoped kernel. No on-chain UserOp fires here — the validator
   *     enableSig is baked lazily on the first session-covered call.
   *
   * Privacy: privateKey lives only in `sessionStorage` (tab-scoped, cleared
   * on close). Backend never receives it. The user is expected to copy it
   * once, paste into broker env, then dismiss the modal — the existing
   * lazy-persist contract in `doInstallSessionKey` keeps the partial
   * record out of disk so reload re-mints a fresh key (acceptable for
   * one-time export).
   */
  async exportSessionKeyPrivateHalf(): Promise<ExportedSessionKey | null> {
    if (!this.kernelClient?.account) return null;

    if (!this.sessionRecord || !this.hasSessionKey()) {
      await this.installSessionKey();
    }

    if (!this.sessionRecord) return null;

    return {
      privateKey: this.sessionRecord.privateKey,
      smartAccountAddress: this.sessionRecord.smartAccountAddress,
      expiresAtSec: this.sessionRecord.expiresAt,
    };
  }

  /**
   * Wave 5 Path D Slice 1 Pickup A — mint a Scoped session-key + construct
   * the matching PermissionValidator + compute `permissionId` locally.
   *
   * **Architectural notes** (load-bearing, do not re-litigate without
   * reading `development/DEV_WAVE_5/PATH_D_PLAN.md` RD-3 + RD-5 + RD-6):
   *
   *  - The ephemeral EOA's private half is returned to the caller so the
   *    Reveal modal can surface it as a one-paste `muhaven-broker update
   *    --session <key>` command (or raw paste into
   *    `MUHAVEN_BROKER_SESSION_KEY`). The dashboard cannot reach
   *    the broker's Unix socket / named pipe directly; the
   *    backend-mirror POST + MCP auto-sync (Commit 2.B) bridges the
   *    transport gap on the next position.buy.
   *  - `permissionValidator.getIdentifier()` is a PURE function over
   *    `policyAndSignerData` (per `@zerodev/permissions/toPermissionValidator`).
   *    It returns the canonical 4-byte `permissionId` even though no
   *    `installPlugin` UserOp has hit the chain yet. The actual on-chain
   *    validator install is deferred to Pickup B / Slice 4 (kernel SDK
   *    enableSig pattern bakes it lazily into the first signed UserOp).
   *  - **Does NOT touch `this.sessionKernelClient` / `this.sessionRecord`.**
   *    The legacy in-tab session-key continues to back covered-selector
   *    silent flows; Scoped mints a SEPARATE ephemeral EOA + validator
   *    so both can coexist on-chain (Kernel v3.1 supports multiple
   *    installed validators routed by the nonce-key composite).
   *  - On-chain `CallPolicy` enforces only `(target, selector, value)`
   *    today — the `@zerodev/permissions` codebase here does not expose
   *    a per-arg cap surface. The `maxSharesHint` cap lives broker-side
   *    in the policy snapshot per RD-5's documented Slice 1 trade-off.
   *    Slice 4 wildcard graduation MUST re-anchor with canonical
   *    `userOpHash` reconstruction.
   */
  async installScopedSessionKey(
    opts: InstallScopedSessionInput,
  ): Promise<ScopedSessionInstallResult | null> {
    if (!this.kernelClient?.account) return null;
    if (!this.webAuthnKeyRef) {
      throw new Error(
        'installScopedSessionKey: passkey reference missing — reconnect wallet first',
      );
    }
    if (opts.ttlSec <= 0) {
      throw new Error('installScopedSessionKey: ttlSec must be a positive integer');
    }
    if (opts.maxSharesPerOp <= 0n) {
      throw new Error('installScopedSessionKey: maxSharesPerOp must be > 0');
    }
    if (opts.maxPerOpUsd6 <= 0n) {
      throw new Error('installScopedSessionKey: maxPerOpUsd6 must be > 0');
    }

    const smartAccountAddress = this.kernelClient.account.address as `0x${string}`;
    const { record } = generateSessionRecord(smartAccountAddress, opts.ttlSec);
    const signer = privateKeyToAccount(record.privateKey);

    const publicClient = buildPublicClient();
    const sessionSigner = await toECDSASigner({ signer });

    // Wave 5 Option D · Commit 1 (D-1) — broad ex-transfer CallPolicy.
    //
    // Slice 1 shipped a deliberately-narrow Scoped envelope
    // (`subscription.purchase` only) because the broker only supported
    // `purchase`. That decision baked the permissionId to a tight
    // (target, selector) set; any later feature (sell, queued claim,
    // yield claim) would have mismatched the permissionId and forced
    // every Scoped user to re-walk the ceremony + re-paste broker keys.
    //
    // Option D broadens the on-chain envelope to mirror the legacy
    // session-key allowlist MINUS `muHavenToken.transfer`. The broker's
    // per-selector `maxAmount` cap remains the narrow off-chain
    // defense; the on-chain CallPolicy is the broad envelope.
    //
    // SecEng T-2: `transfer` is permanently EXCLUDED because a leaked
    // session-key + compromised broker can sign UserOps without further
    // passkey ceremony, and `transfer` has no uint-denominated cap
    // argument the on-chain CallPolicy can bound — including it would
    // permit an attacker to drain RWA holdings. See
    // `frontend/src/providers/zerodev/scoped-permissions.ts` file-level
    // JSDoc + memory
    // `[[feedback-legacy-session-key-allowlist-as-scoped-source-of-truth]]`.
    const scopedCallPolicy = toCallPolicy({
      policyVersion: CallPolicyVersion.V0_0_4,
      permissions: [...SCOPED_AUTONOMOUS_PERMISSIONS] as any,
    });

    const scopedTimestampPolicy = toTimestampPolicy({
      validAfter: 0,
      validUntil: record.expiresAt,
    });

    const permissionValidator = await toPermissionValidator(publicClient, {
      signer: sessionSigner,
      policies: [scopedCallPolicy, scopedTimestampPolicy],
      kernelVersion: KERNEL_VERSION,
      entryPoint: ENTRY_POINT,
    });

    // `getIdentifier()` returns the 4-byte permissionId via a pure
    // `keccak256(policyAndSignerData).slice(0,4)`. No on-chain state
    // required — see `@zerodev/permissions/toPermissionValidator.ts:71-89`.
    const permissionId = permissionValidator.getIdentifier() as `0x${string}`;

    // ────────────────────────────────────────────────────────────────
    // Wave 5 Option D · Commit 2 — capture the on-chain install material.
    //
    // The captured tuple { enableData, enableSig, validatorNonce } is what
    // the C3 MCP-side MODE.ENABLE UserOp re-uses to install this
    // PermissionValidator on first Path D buy. Capturing it here at mint
    // time means the broker can install the validator without a second
    // passkey ceremony from the dashboard — the dashboard pays for the
    // WebAuthn ceremony ONCE and that signature stays valid until the
    // kernel's validator nonce advances.
    //
    // Three steps:
    //   1. Read the on-chain `currentNonce(accountAddress)` via
    //      getKernelV3Nonce. The kernel's plugin manager uses this
    //      nonce as the typed-data domain salt; mismatch on submit →
    //      kernel revert.
    //   2. Build the EIP-712 typed data via getPluginsEnableTypedData
    //      with action = { selector: kernel.execute, address: zero }.
    //      This is byte-for-byte the same envelope the kernel SDK
    //      builds internally on the auto-enable path — the layout was
    //      verified against `@zerodev/sdk/_cjs/.../
    //      getPluginsEnableTypedData.js` line-by-line during the R2
    //      Option D plan review.
    //   3. Sign with the passkey validator's signTypedData. This
    //      triggers ONE WebAuthn ceremony — the user has already done
    //      the 5-tap confirm-token ceremony, so one more tap during
    //      the mint is the right UX cost for "no further passkey
    //      ceremonies on Path D buys."
    //
    // enableData is a pure function over the validator (no chain hit).
    // ────────────────────────────────────────────────────────────────
    const passkeyValidator = await toPasskeyValidator(publicClient, {
      webAuthnKey: this.webAuthnKeyRef,
      entryPoint: ENTRY_POINT,
      kernelVersion: KERNEL_VERSION,
      validatorContractVersion: PasskeyValidatorContractVersion.V0_0_3_PATCHED,
    });

    const validatorNonce = await getKernelV3Nonce(publicClient, smartAccountAddress);

    const action = {
      selector: getActionSelector(ENTRY_POINT.version),
      address: zeroAddress,
    };

    const enableTypedData = await getPluginsEnableTypedData({
      accountAddress: smartAccountAddress,
      chainId: arbitrumSepolia.id,
      kernelVersion: KERNEL_VERSION,
      action,
      validator: permissionValidator,
      validatorNonce,
    });

    // WebAuthn ceremony — keep ensureFocus so the prompt isn't
    // suppressed by an out-of-focus window.
    await WindowHelper.ensureFocus();
    const enableSig = (await passkeyValidator.signTypedData(
      enableTypedData,
    )) as `0x${string}`;

    const enableData = (await permissionValidator.getEnableData(
      smartAccountAddress,
    )) as `0x${string}`;

    return {
      signerAddress: signer.address as `0x${string}`,
      signerPrivateKey: record.privateKey,
      permissionId,
      mintedAtSec: Math.floor(Date.now() / 1000),
      validUntilSec: record.expiresAt,
      smartAccountAddress,
      enableData,
      enableSig,
      validatorNonce,
    };
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
      // Intentionally NOT calling saveSessionRecord here. We defer the
      // persist until `persistSessionAfterFirstUserOp` runs and captures
      // the on-chain enableSig into `serializedAccount`. Saving a record
      // with `privateKey` but no `serializedAccount` opens a half-saved
      // state failure mode: if anything interrupts the persist (page
      // reload, network blip, the user closing the tab right after the
      // first op lands), the next session reloads the half-saved record
      // and tries to install with the same privateKey on a kernel where
      // that exact permissionHash is already enabled → kernel reverts
      // with `AA23 duplicate permissionHash`. By only persisting the
      // complete post-enable record, sessionStorage is always either
      // unset or fully restorable.
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
   * Cache the enableSig after the first successful session UserOp + rebuild
   * the in-memory kernel client into post-enable mode.
   *
   * Two things have to happen here, both load-bearing:
   *
   * 1. Capture `serializedAccount` so a future page reload (within the same
   *    tab — sessionStorage scope) can reconstruct the session without
   *    re-prompting for the passkey enableSig.
   *
   * 2. Replace `this.sessionKernelClient` with one built via
   *    `deserializePermissionAccount`. Without this, the in-memory kernel
   *    stays in pre-enable mode and the *next* userOp through the same
   *    sessionKernelClient still embeds the "enable" signature shape — the
   *    kernel rejects that with `AA23 duplicate permissionHash` because
   *    the validator is already on-chain. The fix is to swap to a kernel
   *    that knows it's enabled before the next send.
   *
   * Callers must `await` this — concurrent / quickly-fired userOps
   * otherwise race onto the stale pre-enable kernel.
   */
  private async persistSessionAfterFirstUserOp(): Promise<void> {
    if (!this.sessionKernelClient?.account) return;
    if (!this.sessionRecord || this.sessionRecord.serializedAccount) return;

    const serialized = await serializePermissionAccount(
      this.sessionKernelClient.account as any,
      this.sessionRecord.privateKey,
    );
    this.sessionRecord = { ...this.sessionRecord, serializedAccount: serialized };
    saveSessionRecord(this.sessionRecord);

    await this.rebuildSessionKernelFromRecord();
  }

  /**
   * Rebuild `this.sessionKernelClient` from the record's `serializedAccount`
   * via `deserializePermissionAccount`. The resulting kernel is in post-enable
   * mode: subsequent userOps sign with the session ECDSA key only, no enable
   * bytes attached.
   *
   * No-op if the record has no `serializedAccount` (i.e. install hasn't
   * succeeded yet) — caller is responsible for ordering.
   */
  private async rebuildSessionKernelFromRecord(): Promise<void> {
    if (!this.sessionRecord?.serializedAccount) return;

    const publicClient = buildPublicClient();
    const sessionSigner = await toECDSASigner({
      signer: signerFromRecord(this.sessionRecord),
    });

    const account = await deserializePermissionAccount(
      publicClient as any,
      ENTRY_POINT,
      KERNEL_VERSION,
      this.sessionRecord.serializedAccount,
      sessionSigner,
    );

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
  }

  /**
   * Wipe both in-memory and persistent session state. Called whenever the
   * session kernel hits an unrecoverable error so the next call starts
   * clean (fresh privateKey → fresh permissionHash → no duplicate revert).
   */
  private invalidateSession(): void {
    if (this._address) clearSessionRecord(this._address);
    this.sessionKernelClient = null;
    this.sessionExpiresAt = 0;
    this.sessionRecord = null;
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

    // Serialize behind any in-flight first-session userOp. Once that
    // resolves the session has been baked (`serializedAccount` set + kernel
    // rebuilt in post-enable mode) and we can send in parallel. Without
    // this gate, two parallel callers both fire the enableSig WebAuthn
    // ceremony from inside `prepareUserOperation` and one aborts the other
    // (`AbortError: Cancelling existing WebAuthn API call for new one`).
    if (this.firstSessionOpPromise) {
      // Catch silently — if the first sender failed, we still want to
      // try our own send (it'll start a fresh first-sender path).
      await this.firstSessionOpPromise.catch(() => {});
    }

    // After waiting, recompute `isFirstSend` against the post-await state.
    // If a previous concurrent caller succeeded, `serializedAccount` is now
    // set and we use the post-enable kernel (no WebAuthn). If they failed,
    // session was invalidated and we become the new first sender.
    const isFirstSend = !this.sessionRecord?.serializedAccount;

    let resolveFirst: () => void = () => {};
    let rejectFirst: (e: unknown) => void = () => {};
    if (isFirstSend) {
      this.firstSessionOpPromise = new Promise<void>((res, rej) => {
        resolveFirst = res;
        rejectFirst = rej;
      });
    }

    let hash: string;
    try {
      if (!this.hasSessionKey()) {
        await this.installSessionKey();
      }
      hash = await this.sendViaKernel(this.sessionKernelClient!, calls);
    } catch (e) {
      console.warn('[ZeroDev] Session-key send failed; falling back to passkey kernel', e);
      // Wipe both in-memory and sessionStorage state. The previous
      // implementation only cleared in-memory and left a poisoned
      // record on disk, which made subsequent in-scope sends repeat the
      // same install → AA23 → fallback loop forever.
      this.invalidateSession();
      if (isFirstSend) {
        rejectFirst(e);
        if (this.firstSessionOpPromise) this.firstSessionOpPromise = null;
      }
      return this.sendViaKernel(this.kernelClient, calls);
    }

    // Persist + rebuild MUST run before the next in-scope userOp, otherwise
    // it picks up the stale pre-enable kernel and reverts AA23 duplicate.
    // Wrapped in its own try/catch because the userOp ALREADY succeeded —
    // we don't want a persist failure to bounce us into the passkey
    // fallback (which would re-send the same tx). On persist failure the
    // session is invalidated for the next call instead. Idempotent —
    // followers (isFirstSend=false) call into a no-op early return.
    try {
      await this.persistSessionAfterFirstUserOp();
    } catch (e) {
      console.warn(
        '[ZeroDev] persist + rebuild failed after successful UserOp — '
        + 'invalidating session so the next call re-installs cleanly',
        e,
      );
      this.invalidateSession();
    }
    if (isFirstSend) {
      // Resolve the gate so any queued followers can proceed. Done in a
      // finally-style block (after persist) so followers always see the
      // post-enable kernel; clearing earlier would let a follower race
      // into an unrebuilt sessionKernelClient.
      resolveFirst();
      if (this.firstSessionOpPromise) this.firstSessionOpPromise = null;
    }
    return hash;
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
