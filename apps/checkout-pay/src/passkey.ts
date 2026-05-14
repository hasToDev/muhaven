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
  b64ToBytes,
  base64FromUint8Array,
  findQuoteIndices,
  hexStringToUint8Array,
  isRIP7212SupportedNetwork,
  parseAndNormalizeSig,
  uint8ArrayToHexString,
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
  encodeAbiParameters,
  http,
  type Address,
  type Hex,
  type SignableMessage,
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
    // dialog, (c) network error. We can't reliably distinguish (a)
    // from (b) without inspecting the error message, but in practice
    // both should fall through to the Register prompt — if the user
    // genuinely meant to cancel they can cancel the register dialog
    // too. Network errors will fail Register as well, surfacing the
    // real problem.
    if (isUserCancelError(err)) {
      throw new PasskeyError('passkey_cancelled', 'Passkey sign-in was cancelled.');
    }
    // Fall through to register.
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

  // Plan C v2 (2026-05-15, post-walkthrough revision) — install a
  // GPM-friendly signMessage callback on the webAuthnKey BEFORE
  // building the kernel.
  //
  // What v1 (initial Plan C) shipped + WHY it didn't trip GPM:
  //   - Added `mediation: 'optional'` to the assertion options
  //     →  NO-OP. `@simplewebauthn/browser`'s startAuthentication only
  //        sets the outer `CredentialRequestOptions.mediation` when
  //        `useBrowserAutofill=true`. Our value got spread into the
  //        inner `publicKey` where the WebAuthn spec ignores it.
  //        'optional' is the spec default anyway — even setting it
  //        at the right level changes nothing.
  //   - Added `transports: ['hybrid', 'internal']` per credential
  //     →  preserved correctly into `navigator.credentials.get(...)`
  //        BUT: the presence of `'internal'` in the transport hint
  //        causes Chrome on Windows 11 to defer the picker to the
  //        OS-native `webauthn.dll` dialog. That OS dialog does NOT
  //        consult Chrome's Google Password Manager credential store
  //        (GPM is mediated by Chrome's own `PasskeyModelImpl`).
  //        Net effect: Windows Hello only, GPM invisible.
  //
  // Diagnosis source: research agent + Chrome for Developers blog
  // "passkeys-gpm-desktop" + 1Password community thread describing
  // the same Windows-Hello-hijack pattern triggered by `transports:
  // ['internal']`.
  //
  // What v2 changes:
  //   - Drop the no-op `mediation` field entirely.
  //   - Replace `transports: ['hybrid', 'internal']` with
  //     `transports: ['hybrid']`. The 'hybrid' hint keeps Chrome in
  //     its in-browser picker (not OS-deferred), which can surface
  //     BOTH GPM-stored credentials AND offer the phone-cross-device
  //     QR flow when applicable.
  //   - Add console.debug logging so the operator can verify in
  //     DevTools that the callback IS firing + see the exact options
  //     handed to startAuthentication.
  //
  // If v2 still routes to Windows Hello, the empirical conclusion is
  // that the credential simply isn't in GPM — the fix then has to be
  // architectural (Proposal 1: move buyer page to muhaven.app/pay/
  // so the dashboard's GPM-backed credential is reachable via same-
  // origin instead of subdomain-of-apex).
  //
  // Cast: upstream's `signMessageCallback` types `allowCredentials`
  // against `PublicKeyCredentialDescriptorJSON` (from
  // @simplewebauthn/types — not a direct dep). Our locally-typed
  // shape is structurally compatible at runtime; the cast pins the
  // assignment without pulling the upstream type lib.
  webAuthnKey.signMessageCallback =
    signMessageWithGpmFriendlyAssertion as unknown as typeof webAuthnKey.signMessageCallback;

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

/**
 * Plan C v2 (2026-05-15, post-walkthrough revision) — signMessage
 * callback that keeps Chrome in its in-browser picker (so GPM-stored
 * credentials remain visible) instead of being deferred to the OS-
 * native Windows Hello dialog.
 *
 * Re-implements the signature encoding from `signMessageUsingWebAuthn`
 * in @zerodev/passkey-validator (see
 * `development/reference/ZeroDev/sdk/plugins/passkey/toPasskeyValidator.ts`),
 * changing only the assertion-dialog hints:
 *   - Drops the no-op `mediation` field (v1 placed it inside `publicKey`
 *     where the spec doesn't define it — net-zero effect).
 *   - Sets `transports: ['hybrid']` per credential. 'hybrid' is the
 *     cross-device / phone-as-authenticator transport. CRITICALLY,
 *     the list does NOT include 'internal' — including 'internal'
 *     is what causes Chrome on Windows 11 to defer to webauthn.dll's
 *     OS dialog, which can only see Windows Hello + TPM credentials
 *     and is blind to GPM's credential store.
 *
 * The signature encoding (ABI-encoded tuple of authenticatorData,
 * clientDataJSON, responseTypeLocation, r, s, usePrecompiled) is
 * byte-identical to the upstream implementation so the on-chain
 * WebAuthn verifier accepts it without contract changes. Only the
 * authentication-dialog options differ.
 *
 * Diagnostic instrumentation: console.debug lines log the callback
 * invocation + the actual assertion options. Filter the DevTools
 * console by `[Plan C v2]` to verify the callback fired + the
 * options the browser saw.
 *
 * Test matrix targeted by this fix: Chrome+Windows (GPM signed-in),
 * Edge+Windows, Chrome+Mac, Safari+Mac. Mac platforms already work;
 * Windows-Chrome is the regression this revision targets.
 */
async function signMessageWithGpmFriendlyAssertion(
  message: SignableMessage,
  _rpId: string,
  chainId: number,
  allowCredentials?: Array<{ id: string; type: 'public-key'; transports?: AuthenticatorTransport[] }>,
): Promise<Hex> {
  // Plan C v2 diagnostic — confirms the override is installed +
  // visible in DevTools so we can rule out "callback never fired"
  // as a failure mode on the next walkthrough.
  console.debug('[Plan C v2] signMessageCallback fired', {
    chainId,
    allowCredentialsCount: allowCredentials?.length ?? 0,
  });

  let messageContent: string;
  if (typeof message === 'string') {
    messageContent = message;
  } else if ('raw' in message && typeof message.raw === 'string') {
    messageContent = message.raw;
  } else if ('raw' in message && message.raw instanceof Uint8Array) {
    messageContent = message.raw.toString();
  } else {
    throw new Error('Unsupported message format');
  }

  const formattedMessage = messageContent.startsWith('0x')
    ? messageContent.slice(2)
    : messageContent;

  const challenge = base64FromUint8Array(
    hexStringToUint8Array(formattedMessage),
    true,
  );

  // Plan C v2 — replace each allowCredentials entry's transports
  // with `['hybrid']` only. Upstream passes no transports at all
  // (browser default = consider every authenticator), which on
  // Windows means the OS picker still wins. v1 added 'internal' to
  // the list, which paradoxically triggered the exact OS-deferral
  // we're trying to escape. v2 keeps only 'hybrid' to bias the
  // browser toward its in-process picker.
  const enrichedAllowCredentials = allowCredentials?.map((c) => ({
    id: c.id,
    type: c.type,
    transports: ['hybrid'] as AuthenticatorTransport[],
  }));

  const assertionOptions = {
    challenge,
    allowCredentials: enrichedAllowCredentials,
    userVerification: 'required' as const,
  };

  console.debug('[Plan C v2] assertionOptions sent to startAuthentication', {
    userVerification: assertionOptions.userVerification,
    allowCredentialsTransports: enrichedAllowCredentials?.map((c) => c.transports),
    challengeLen: challenge.length,
  });

  // @simplewebauthn/browser is a direct dep — runtime resolution +
  // types both work. Dynamic import keeps the cold-start path lean
  // (matches the upstream pattern).
  const wAuthn = (await import(
    /* @vite-ignore */ '@simplewebauthn/browser'
  )) as { startAuthentication: (opts: unknown) => Promise<{
    response: {
      authenticatorData: string;
      clientDataJSON: string;
      signature: string;
    };
  }> };
  const cred = await wAuthn.startAuthentication(assertionOptions);
  console.debug('[Plan C v2] startAuthentication returned credential', {
    hasResponse: !!cred?.response,
  });

  const { authenticatorData } = cred.response;
  const authenticatorDataHex = uint8ArrayToHexString(b64ToBytes(authenticatorData));
  const clientDataJSON = atob(cred.response.clientDataJSON);
  const { beforeType } = findQuoteIndices(clientDataJSON);
  const { signature } = cred.response;
  const signatureHex = uint8ArrayToHexString(b64ToBytes(signature));
  const { r, s } = parseAndNormalizeSig(signatureHex);

  // ABI encoding MUST match toPasskeyValidator.ts exactly — order +
  // types of the tuple are pinned by the WebAuthn verifier contract.
  return encodeAbiParameters(
    [
      { name: 'authenticatorData', type: 'bytes' },
      { name: 'clientDataJSON', type: 'string' },
      { name: 'responseTypeLocation', type: 'uint256' },
      { name: 'r', type: 'uint256' },
      { name: 's', type: 'uint256' },
      { name: 'usePrecompiled', type: 'bool' },
    ],
    [
      authenticatorDataHex,
      clientDataJSON,
      beforeType,
      BigInt(r),
      BigInt(s),
      isRIP7212SupportedNetwork(chainId),
    ],
  );
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
