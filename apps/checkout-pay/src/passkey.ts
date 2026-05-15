/**
 * Wave 4 P5 (Wave-5 buyer-side port, P1) — ZeroDev passkey ceremony
 * for the hosted-checkout buyer page.
 *
 * Slim mirror of `frontend/src/providers/zerodev/zerodev.provider.ts`.
 * The dashboard's provider is 848 lines because it also owns session
 * keys, set-policy, claim, transfer, and the redemption-queue surface;
 * the buyer page only needs:
 *   - Provision a kernel (register a new credential OR sign in to an
 *     existing one).
 *   - Expose a `KernelAccountClient` for downstream UserOps (wrap,
 *     approve, purchase — wired in P3).
 *   - Expose the kernel's address for the funding-poll (P2) and the
 *     backend `transition` call.
 *
 * Operator-side prereq (LANDED 2026-05-1?): the stage ZeroDev project
 * (`VITE_ZERODEV_BUNDLER_URL` af200bff-...) has both
 * `https://stage.muhaven.app` (dashboard) AND
 * `https://pay-stage.muhaven.app` (this page) listed under Domains.
 * Without that, `toWebAuthnKey` 401s on the passkey server.
 *
 * Sign-in UX: `connectOrCreate()` tries Login first; if no credential
 * exists for this RP-ID the WebAuthn dialog returns
 * `NotAllowedError`/`InvalidStateError`/empty allowCredentials list,
 * and we fall back to Register. This means a returning buyer (who
 * registered a credential previously on either surface) gets a
 * single-tap sign-in, and a brand-new buyer gets the one-tap
 * registration. The UI surface stays a single button.
 */

import {
  toWebAuthnKey,
  WebAuthnMode,
  type WebAuthnKey,
} from '@zerodev/webauthn-key';
import {
  toPasskeyValidator,
  PasskeyValidatorContractVersion,
} from '@zerodev/passkey-validator';
import {
  createKernelAccount,
  createKernelAccountClient,
  createZeroDevPaymasterClient,
  constants,
  type KernelAccountClient,
} from '@zerodev/sdk';
import {
  http,
  type Address,
} from 'viem';
import { entryPoint07Address } from 'viem/account-abstraction';
import {
  ARB_SEPOLIA_CHAIN,
  getBundlerUrl,
  getPasskeyServerUrl,
  getPublicClient,
} from './chain.js';

const ENTRY_POINT = { address: entryPoint07Address, version: '0.7' as const };
const KERNEL_VERSION = constants.KERNEL_V3_1;

/**
 * Default passkey display name for newly-registered buyer credentials.
 * The OS passkey manager shows this in the user's credential list so
 * they can distinguish MuHaven from other RPs.
 */
const DEFAULT_PASSKEY_NAME = 'MuHaven Buyer';

export interface BuyerKernel {
  address: Address;
  kernelClient: KernelAccountClient;
  webAuthnKey: WebAuthnKey;
  /** `true` if the credential was newly registered, `false` if existing. */
  newlyRegistered: boolean;
}

/**
 * Run the passkey ceremony. Tries login first; on no-credential
 * (NotAllowedError / cancelled-by-platform / empty allowCredentials)
 * falls back to register.
 *
 * Throws if BOTH login and register fail or are user-cancelled.
 */
export async function connectOrCreate(
  passkeyName: string = DEFAULT_PASSKEY_NAME,
): Promise<BuyerKernel> {
  await ensureFocus();
  const passkeyServerUrl = getPasskeyServerUrl();

  // Try login first.
  let webAuthnKey: WebAuthnKey | null = null;
  let newlyRegistered = false;
  try {
    webAuthnKey = await toWebAuthnKey({
      passkeyName: '',
      passkeyServerUrl,
      mode: WebAuthnMode.Login,
    });
  } catch (err) {
    // Login can fail because (a) no credential exists for this RP-ID
    // (the common new-buyer case), (b) the user cancelled the OS
    // dialog, (c) network error. Chrome surfaces (a) AND (b) BOTH as
    // `NotAllowedError` so we cannot distinguish them at this layer.
    //
    // 2026-05-17 fix: previously we early-threw on NotAllowedError,
    // which blocked new buyers — Register never ran. Now we ALWAYS
    // fall through to Register on any Login failure (matching what the
    // long-standing comment claimed but the code didn't do). UX trade:
    // a user who DID cancel sees a Register dialog they didn't ask for,
    // but they can cancel that too and the Register-cancel branch
    // surfaces the `passkey_cancelled` error cleanly.
  }

  if (!webAuthnKey) {
    try {
      webAuthnKey = await toWebAuthnKey({
        passkeyName,
        passkeyServerUrl,
        mode: WebAuthnMode.Register,
      });
      newlyRegistered = true;
    } catch (err) {
      if (isUserCancelError(err)) {
        throw new PasskeyError(
          'passkey_cancelled',
          'Passkey registration was cancelled.',
        );
      }
      throw new PasskeyError(
        'passkey_unavailable',
        err instanceof Error ? err.message : 'Passkey ceremony failed.',
      );
    }
  }

  // DO NOT override `webAuthnKey.signMessageCallback` on Windows.
  // Plan C v1+v2+v3 (2026-05-14 → 2026-05-15) tried `transports:
  // ['hybrid', 'internal']`, then `['hybrid']`, then subdomain-
  // collapse to muhaven.app/pay/. All three were empirically
  // refuted (2026-05-15+, walkthroughs on Win+Chrome+GPM): for
  // platform-bound credentials, Windows 11 controls the assertion
  // dialog at the OS level and ignores Chrome-side hints/transports
  // entirely (corbado.com/blog/webauthn-public-key-credential-hints).
  // Worse: passing a narrowed transports array that Windows can't
  // satisfy actively shrinks the picker (Chrome dropped the "Use a
  // different device" QR option that upstream's no-transports path
  // surfaces by default). Letting upstream's signMessageUsingWebAuthn
  // run unmodified is the correct path — its default `[{id, type}]`
  // descriptor lets Chrome+Windows surface every available signing
  // route (Windows Hello + cross-device QR). Users wanting GPM-direct
  // signing must register a hybrid-discoverable credential (phone QR
  // or Mac/iCloud Keychain); platform-bound Windows Hello credentials
  // sign via Windows Hello, by OS design.

  const kernelClient = await buildKernelClient(webAuthnKey);
  const account = kernelClient.account;
  if (!account) {
    throw new PasskeyError(
      'kernel_provision_failed',
      'Kernel account not provisioned after passkey ceremony.',
    );
  }
  return {
    address: account.address,
    kernelClient,
    webAuthnKey,
    newlyRegistered,
  };
}

async function buildKernelClient(
  webAuthnKey: WebAuthnKey,
): Promise<KernelAccountClient> {
  const publicClient = getPublicClient();
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

  // ZeroDev's default testnet paymaster sponsors gas. Production
  // (Wave 5 P3.B) swaps to an issuer-funded paymaster + permission
  // template so each issuer covers their buyers' gas.
  const paymaster = createZeroDevPaymasterClient({
    chain: ARB_SEPOLIA_CHAIN,
    transport: http(bundlerUrl),
  });

  return createKernelAccountClient({
    account,
    chain: ARB_SEPOLIA_CHAIN,
    bundlerTransport: http(bundlerUrl),
    paymaster,
  });
}

/**
 * Best-effort focus restoration before invoking a WebAuthn dialog.
 * Browsers gate `navigator.credentials.get/create` on a recent user
 * gesture — calling from a click handler is the canonical pattern,
 * but if the page's iframe ancestry or some intermediate `await`
 * has consumed the gesture, we re-focus the window so the dialog
 * doesn't silently fail. Mirrors `frontend`'s `WindowHelper.ensureFocus`.
 */
async function ensureFocus(): Promise<void> {
  if (typeof window === 'undefined') return;
  if (document.hasFocus()) return;
  try {
    window.focus();
  } catch {
    // window.focus() can throw in cross-origin frames; ignore.
  }
}

/**
 * Heuristic for "user cancelled" vs "passkey infrastructure broken".
 * WebAuthn error surfaces vary by browser:
 *  - Chrome / Edge: `NotAllowedError` (user cancelled OR no credential)
 *  - Firefox: `NotAllowedError` (same)
 *  - Safari: `NotAllowedError` (same)
 *  - All: `AbortError` if the dialog is interrupted by another
 *
 * We can't distinguish "cancelled" from "no credential" without
 * inspecting the message — and ZeroDev's server-side passkey response
 * may surface "no credentials" as its own shape. The caller treats
 * Login → cancel/no-credential AS a signal to try Register, and only
 * surfaces a hard error when Register itself is cancelled.
 */
function isUserCancelError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name;
  return name === 'NotAllowedError' || name === 'AbortError';
}

export class PasskeyError extends Error {
  constructor(
    public readonly code:
      | 'passkey_cancelled'
      | 'passkey_unavailable'
      | 'kernel_provision_failed',
    message: string,
  ) {
    super(message);
    this.name = 'PasskeyError';
  }
}
