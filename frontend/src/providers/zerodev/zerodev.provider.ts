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
import {
  createPublicClient,
  createWalletClient,
  http,
  toFunctionSelector,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { signMessage as viemSignMessage } from 'viem/actions';
import { arbitrumSepolia } from 'viem/chains';
import { entryPoint07Address } from 'viem/account-abstraction';
import { WindowHelper } from '@/helpers/WindowHelper';
import { addresses as CONTRACTS, v35Addresses } from '@/contracts/addresses';
import {
  yieldDistributorAbi,
  muhavenEscrowAbi,
  pusdcAbi,
  muHavenTokenAbi,
} from '@/contracts/abis';
import {
  muhavenSubscriptionAbi,
  redemptionQueueAbi,
  yieldSnapshotAbi,
  muHavenStableAbi,
} from '@muhaven/sdk';
import {
  generateSessionRecord,
  loadSessionRecord,
  saveSessionRecord,
  clearSessionRecord,
  signerFromRecord,
  isRecordValid,
  expirySecondsRemaining,
  setSessionPermsVersion,
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

// Dedicated single-entry ABI for `MuHavenToken.transfer(address,InEuint128,address)`
// — the Wave 3.5 overload per ADR-021. The full `muHavenTokenAbi` carries
// both the Wave 3 and Wave 3.5 transfer signatures, which would make
// `toCallPolicy`'s selector inference ambiguous. Constraining the scope to
// the new ephemeralEOA-bearing overload also means a stale frontend that
// somehow falls back to the legacy 2-arg path would correctly miss session
// scope and bounce to the passkey kernel.
const muHavenTokenTransferV35Abi = [
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      {
        name: 'encryptedAmount',
        type: 'tuple',
        components: [
          { name: 'ctHash', type: 'uint256' },
          { name: 'securityZone', type: 'uint8' },
          { name: 'utype', type: 'uint8' },
          { name: 'signature', type: 'bytes' },
        ],
      },
      { name: 'ephemeralEOA', type: 'address' },
    ],
    outputs: [],
  },
] as const;

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

function nonZero<T extends { target: string }>(perms: readonly T[]): T[] {
  return perms.filter((p) => p.target.toLowerCase() !== ZERO_ADDR);
}

/**
 * Collapse permissions that share the same `(target, selector)` to a single
 * entry. The deployed `CallPolicy` contracts (notably V0_0_4 at
 * `0x9a52283276A0ec8740DF50bF01B28A80D880eaf2`) reject duplicate
 * `(target, selector)` pairs at install time with `revert("duplicate
 * permissionHash")`. Duplicates are easy to introduce by accident in our
 * env: when the same `YieldSnapshot` proxy serves multiple RWA tokens
 * (e.g. staging maps both TBILL1 and GOLD1 to the same snapshot
 * address), the `Object.values(yieldSnapshots).map(...)` expansion
 * yields N identical entries. Without this dedupe, every session-key
 * install reverts AA23 on the first userOp and falls back to the passkey
 * kernel — silently regressing the prompt budget. We compute the
 * selector from the entry's abi + functionName since we may be called
 * before `SESSION_SCOPE_KEYS` is initialised.
 */
function dedupePermissions<
  T extends { target: string; abi: readonly any[]; functionName: string },
>(perms: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const perm of perms) {
    const abiItem = (perm.abi as readonly any[]).find(
      (item) => item.type === 'function' && item.name === perm.functionName,
    );
    if (!abiItem) {
      throw new Error(`dedupePermissions: missing ABI for ${perm.functionName}`);
    }
    const selector = toFunctionSelector(abiItem).toLowerCase();
    const key = `${perm.target.toLowerCase()}:${selector}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(perm);
  }
  return out;
}

/**
 * The narrow allowlist the session validator is scoped to.
 *
 * Wave 3 (legacy) flows: issuer distribute + investor escrow redeem +
 * PUSDC operator setup.
 *
 * Wave 3.5 (atomic + queued + pull-yield) flows: investor purchase /
 * redeem / queued submit+claim / yield claim, plus P2P transfer per
 * ADR-021's ephemeralEOA-bearing transfer overload.
 *
 * RedemptionQueue + YieldSnapshot are deployed per-token, so we expand
 * each map at module-load time. Any address still defaulting to
 * `0x0000…0000` (Wave 3.5 not yet onboarded for that env) is filtered
 * out — including a zero target would let the policy match unrelated
 * Wave 3 calls to address(0).
 *
 * Any UserOp targeting a contract/function outside this set will be
 * rejected by the policy — `isCallInSessionScope` short-circuits the
 * session install in that case so we don't trigger an enableSig prompt
 * for a guaranteed-failing UserOp.
 */
const queuePermissions = nonZero(
  Object.values(v35Addresses.queues).flatMap((queueAddr) => [
    { target: queueAddr, functionName: 'submit', abi: redemptionQueueAbi, valueLimit: 0n },
    { target: queueAddr, functionName: 'claim', abi: redemptionQueueAbi, valueLimit: 0n },
  ]),
);

const snapshotPermissions = nonZero(
  Object.values(v35Addresses.yieldSnapshots).flatMap((snapAddr) => [
    { target: snapAddr, functionName: 'claimYield', abi: yieldSnapshotAbi, valueLimit: 0n },
    // Wave 3.5 issuer-side distribution (Phase 9.A · /distribute Wave-3.5
    // rewrite). Replaces the script-only path. Same proxy is reused
    // across multiple RWA tokens on staging — `dedupePermissions` collapses
    // collisions for proxies appearing under multiple keys.
    { target: snapAddr, functionName: 'openEpoch', abi: yieldSnapshotAbi, valueLimit: 0n },
    { target: snapAddr, functionName: 'snapshotBatch', abi: yieldSnapshotAbi, valueLimit: 0n },
    { target: snapAddr, functionName: 'finalizeSnapshot', abi: yieldSnapshotAbi, valueLimit: 0n },
    { target: snapAddr, functionName: 'fundEpoch', abi: yieldSnapshotAbi, valueLimit: 0n },
    // Phase 9.A audit-handle follow-up — cross-session decrypt for the
    // YieldClaimed audit handle. Lets investors re-stamp ACL on a
    // historical claim handle via session-key (no passkey prompt) when
    // they revisit /activity in a new browser session. Mirror of the
    // MuHavenStable.refreshAuditGrant + MuHavenToken.refreshAuditGrant
    // entries elsewhere in this file.
    { target: snapAddr, functionName: 'refreshAuditGrant', abi: yieldSnapshotAbi, valueLimit: 0n },
    // Phase 9.C / L2 follow-up — re-stamp issuer's L2 ACL grant on
    // encTotalSupply onto a fresh ephemeralEOA. Frontend calls this
    // before decrypt-from-chain to satisfy the cofhe permit's eph-
    // signer ACL check (kernels can't sign permits per ADR-009).
    { target: snapAddr, functionName: 'refreshSnapshotSupplyGrant', abi: yieldSnapshotAbi, valueLimit: 0n },
  ]),
);

// Issuer-side mhUSDC operator approval — required so YieldSnapshot can
// pull mhUSDC from the issuer during fundEpoch. One-shot per (issuer,
// snapshotProxy) pair until expiry. Without this entry, the operator-
// approval tx falls back to the passkey kernel mid-distribution and
// breaks the silent-flow rhythm of the wizard.
const stableOperatorPermissions = nonZero([
  {
    target: v35Addresses.muHavenStable,
    functionName: 'setOperator',
    abi: muHavenStableAbi,
    valueLimit: 0n,
  },
]);

const subscriptionPermissions = nonZero([
  {
    target: v35Addresses.subscription,
    functionName: 'purchase',
    abi: muhavenSubscriptionAbi,
    valueLimit: 0n,
  },
  {
    target: v35Addresses.subscription,
    functionName: 'redeem',
    abi: muhavenSubscriptionAbi,
    valueLimit: 0n,
  },
]);

// Self-service ACL refresh primitives (ADR-042 + Phase 7.5 mirror). These
// don't move funds — they only re-grant FHE decrypt access on the caller's
// own balance handle to a passed `ephemeralEOA`. Without them in scope,
// the first decrypt-after-page-reload (when the in-memory ephemeral EOA
// regenerates against a stale on-chain ACL) bounces to the passkey kernel
// for what should be a silent UX path. Strictly weaker than the purchase /
// redeem / transfer entries already in scope.
//
// Wave 3.5 onboards each RWA as its own MuHavenToken proxy (TBILL1, GOLD1,
// …), so we expand `refreshDecryptGrant` per per-token contract. The
// per-token map is derived from `treasuries` (or queues / yieldSnapshots —
// same key set: the JSON map keys are the per-token MuHavenToken
// addresses). Without this expansion, a portfolio decrypt on TBILL1 / GOLD1
// can't refresh its grant via the session key — falls back to the passkey
// kernel, and two parallel `Promise.all` decrypts race two concurrent
// WebAuthn ceremonies that abort each other.
const perTokenRwaAddresses = Object.keys(v35Addresses.treasuries) as Address[];
const refreshGrantPermissions = nonZero([
  // Wave 3 single-token surface (back-compat with `MPrivacyProofPanel`).
  {
    target: CONTRACTS.muHavenToken,
    functionName: 'refreshDecryptGrant',
    abi: muHavenTokenAbi,
    valueLimit: 0n,
  },
  // Per-RWA Wave 3.5 token contracts (TBILL1, GOLD1, …).
  ...perTokenRwaAddresses.map((addr) => ({
    target: addr,
    functionName: 'refreshDecryptGrant' as const,
    abi: muHavenTokenAbi,
    valueLimit: 0n,
  })),
  // Phase 9.A · Option Z follow-up — Transfer audit-handle re-grant for
  // /activity cross-session decrypts on per-RWA tokens. Each RWA needs
  // its own entry because `refreshAuditGrant` is gated by the token
  // contract's own ACL state.
  ...perTokenRwaAddresses.map((addr) => ({
    target: addr,
    functionName: 'refreshAuditGrant' as const,
    abi: muHavenTokenAbi,
    valueLimit: 0n,
  })),
  {
    target: v35Addresses.muHavenStable,
    functionName: 'refreshDecryptGrant',
    abi: muHavenStableAbi,
    valueLimit: 0n,
  },
  // Phase 9.A · Option Z follow-up — mhUSDC historical audit-handle
  // re-grant for cross-session Wrap/Unwrap decrypts on /activity.
  {
    target: v35Addresses.muHavenStable,
    functionName: 'refreshAuditGrant',
    abi: muHavenStableAbi,
    valueLimit: 0n,
  },
]);

// Raw permissions list. Multiple per-token expansions can collide on
// `(target, selector)` if two tokens share the same queue / snapshot
// proxy — that's normal, e.g. staging's YieldSnapshot is one proxy
// shared across all RWA tokens. `dedupePermissions` below collapses
// such collisions so the CallPolicy contract doesn't revert at install
// with `duplicate permissionHash`.
const RAW_SESSION_PERMISSIONS = [
  // Wave 3 legacy
  { target: CONTRACTS.yieldDistributor, functionName: 'startDistribution', abi: yieldDistributorAbi, valueLimit: 0n },
  { target: CONTRACTS.yieldDistributor, functionName: 'setEscrowIds', abi: yieldDistributorAbi, valueLimit: 0n },
  { target: CONTRACTS.yieldDistributor, functionName: 'processBatch', abi: yieldDistributorAbi, valueLimit: 0n },
  { target: CONTRACTS.muhavenEscrow, functionName: 'batchCreate', abi: muhavenEscrowAbi, valueLimit: 0n },
  { target: CONTRACTS.muhavenEscrow, functionName: 'redeem', abi: muhavenEscrowAbi, valueLimit: 0n },
  { target: CONTRACTS.muhavenEscrow, functionName: 'redeemMultiple', abi: muhavenEscrowAbi, valueLimit: 0n },
  { target: CONTRACTS.pusdc, functionName: 'setOperator', abi: pusdcAbi, valueLimit: 0n },
  // Wave 3.5 — P2P transfer (ephemeralEOA overload)
  {
    target: CONTRACTS.muHavenToken,
    functionName: 'transfer',
    abi: muHavenTokenTransferV35Abi,
    valueLimit: 0n,
  },
  // Wave 3.5 — Subscription / Queues / Snapshots (any may be empty when
  // the env has not yet onboarded Wave 3.5 contracts)
  ...subscriptionPermissions,
  ...queuePermissions,
  ...snapshotPermissions,
  ...stableOperatorPermissions,
  ...refreshGrantPermissions,
];

const SESSION_PERMISSIONS = dedupePermissions(RAW_SESSION_PERMISSIONS);

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

/**
 * Stable fingerprint of the currently-installed session policy. Embedded
 * in the sessionStorage key (see `session-key.ts::storageKey`) so that
 * any source-side change to `SESSION_PERMISSIONS` (target add / remove,
 * function add / remove) auto-invalidates older cached records — forcing
 * `installSessionKey` to mint a fresh validator install whose on-chain
 * CallPolicy matches what the local code thinks is in scope. Without
 * this guard, a session installed under a previous policy survives the
 * code change but silently AA23-reverts on any newly-added permission
 * (the on-chain validator state is bound at install time, not re-read
 * on every userOp).
 *
 * 8 hex chars = 32 bits of stable fingerprint; collision probability
 * across our < 100 permission combinations is negligible.
 */
const SESSION_PERMS_FINGERPRINT = keccak256(
  toHex([...SESSION_SCOPE_KEYS].sort().join('|')),
).slice(2, 10);
setSessionPermsVersion(SESSION_PERMS_FINGERPRINT);

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
