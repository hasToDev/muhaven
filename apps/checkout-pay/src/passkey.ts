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

  // Plan C (2026-05-15) — install a GPM-friendly signMessage callback
  // on the webAuthnKey BEFORE building the kernel. The default
  // `signMessageUsingWebAuthn` in @zerodev/passkey-validator (v5.6.0
  // confirmed via `development/reference/ZeroDev/sdk/plugins/passkey/
  // toPasskeyValidator.ts:43-77`) constructs assertion options with
  // only `challenge + allowCredentials + userVerification: required`.
  // It omits `mediation` and per-credential `transports`, which on
  // Windows + Chrome means the OS picker offers Windows Hello only,
  // even when the same passkey is also stored in GPM.
  //
  // `WebAuthnKey.signMessageCallback` is the upstream-supported
  // override hook — when set, toPasskeyValidator calls it instead of
  // the default signer. We re-implement the same signature encoding
  // (using helpers exported from @zerodev/webauthn-key — b64ToBytes,
  // findQuoteIndices, parseAndNormalizeSig, etc.) but add
  // `mediation: 'optional'` + `transports: ['hybrid', 'internal']` to
  // the assertion. `'hybrid'` tells the picker to ALSO offer the
  // QR / phone-as-authenticator path that GPM advertises through.
  // Cast: upstream's `signMessageCallback` types `allowCredentials` against
  // `PublicKeyCredentialDescriptorJSON` (from @simplewebauthn/types — not a
  // direct dep). Our locally-typed shape is structurally compatible at
  // runtime; the cast pins the assignment without pulling the upstream
  // type lib.
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
 * Plan C (2026-05-15) — GPM-friendly signMessage callback.
 *
 * Re-implements the signature encoding from `signMessageUsingWebAuthn`
 * in @zerodev/passkey-validator (see
 * `development/reference/ZeroDev/sdk/plugins/passkey/toPasskeyValidator.ts`),
 * adding:
 *   - `mediation: 'optional'` — surfaces the full OS picker so non-
 *     platform authenticators (GPM, cross-device QR) appear alongside
 *     Windows Hello. Without this, Chromium-on-Win prefers the platform
 *     authenticator and silently filters out GPM.
 *   - `transports: ['hybrid', 'internal']` — hints to the browser that
 *     this credential is reachable via BOTH the platform path AND the
 *     cross-device / phone-as-authenticator path. GPM-stored passkeys
 *     advertise through 'hybrid' (formerly caBLE); restricting to
 *     'internal' alone would re-hide GPM.
 *
 * The signature encoding (ABI-encoded tuple of authenticatorData,
 * clientDataJSON, responseTypeLocation, r, s, usePrecompiled) is
 * byte-identical to the upstream implementation so the on-chain
 * WebAuthn verifier accepts it without contract changes. Only the
 * authentication-dialog options differ.
 *
 * Test matrix targeted by this fix: Chrome+Windows (GPM signed-in),
 * Edge+Windows, Chrome+Mac, Safari+Mac. Mac platforms already work
 * (Apple's authenticator surfaces iCloud-synced passkeys); Windows is
 * the regression this commit closes.
 */
async function signMessageWithGpmFriendlyAssertion(
  message: SignableMessage,
  _rpId: string,
  chainId: number,
  allowCredentials?: Array<{ id: string; type: 'public-key'; transports?: AuthenticatorTransport[] }>,
): Promise<Hex> {
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

  // Plan C — extend each allowCredentials entry with the broadened
  // transports list. Upstream passes credentials WITHOUT transports,
  // which is what hides GPM on Win+Chrome. Keep `id` + `type` as-is.
  const enrichedAllowCredentials = allowCredentials?.map((c) => ({
    id: c.id,
    type: c.type,
    transports: c.transports ?? (['hybrid', 'internal'] as AuthenticatorTransport[]),
  }));

  const assertionOptions = {
    challenge,
    allowCredentials: enrichedAllowCredentials,
    userVerification: 'required' as const,
    // Plan C key change: `'optional'` surfaces the picker for every
    // matching authenticator instead of silently choosing the platform
    // default. WebAuthn spec values: silent / optional / required /
    // conditional. We pick 'optional' (the spec's recommended default)
    // rather than 'required' (which forces a picker even when only one
    // authenticator matches — fine for our case but unnecessary).
    mediation: 'optional' as CredentialMediationRequirement,
  };

  // @simplewebauthn/browser is a transitive dep through
  // @zerodev/passkey-validator — runtime resolution succeeds, but the
  // package doesn't ship its own .d.ts entry into our typecheck. Cast
  // the dynamic-import to `any` so we sidestep the unresolved-module
  // diagnostic; the call-site below is shape-checked by usage.
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
