/**
 * Wave 4 P5 (Wave-5 buyer-side port, P3) — cofhe client init for the
 * hosted-checkout buyer page.
 *
 * Slim mirror of `frontend/src/composables/useFhe.ts` minus the Vue /
 * Pinia coupling. The buyer page is plain TS; this module owns:
 *  - A per-session ephemeral EOA (private key in memory only, never
 *    persisted to localStorage / sessionStorage — same posture as the
 *    dashboard per ADR-021).
 *  - Lazy `@cofhe/sdk/web` + `@cofhe/sdk/chains` imports so the cofhe
 *    bundle (~200KB) only loads when the buyer actually proceeds past
 *    the funding step.
 *  - Idempotent `getCofheClient()` that connects once + reuses.
 *  - `ensureFreshSelfPermit()` wrapper that closes the SDK's "permit
 *    returned expired" trap (see `feedback_cofhe_permit_expiration_unchecked`).
 *
 * Why a per-page ephemeral EOA: the buyer page provisions a kernel via
 * passkey, but the kernel CANNOT sign cofhe permits — counterfactual
 * smart accounts have no stable signing key the ZK verifier can recover.
 * The ephemeral EOA bridges this: cofhe encryption + permit signatures
 * use the EOA; on-chain `FHE.allow(handle, ephemeralEOA)` grants this
 * EOA decrypt rights post-mutation. The EOA's private key never leaves
 * the page — it's regenerated on every page load (single-tab session).
 *
 * The kernel address is what `msg.sender` sees on-chain, so cofhe
 * `encryptInputs(...)` must `.setAccount(kernelAddress)` BEFORE
 * execute — otherwise the on-chain `FHE.asEuint*` reverts with
 * cofhe's `InvalidSigner` (selector 0x7ba5ffb5). The buyer page's
 * write context wires this binding in `context.ts:buildBuyerContext`.
 */

import {
  createWalletClient,
  http,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { getPublicClient, getRpcUrl, ARB_SEPOLIA_CHAIN } from './chain.js';

type CofheClient = Awaited<
  ReturnType<typeof import('@cofhe/sdk/web').createCofheClient>
>;

// ── Module-level singletons ─────────────────────────────────────────
// The cofhe client + ephemeral key live at module scope (single-tab
// session) — same shape as the dashboard's useFhe but without the
// Pinia store layer.

let cofheClient: CofheClient | null = null;
let initPromise: Promise<CofheClient> | null = null;
let ephemeralPrivateKey: `0x${string}` | null = null;
let ephemeralAddress: Address | null = null;

// ── Lazy SDK imports ────────────────────────────────────────────────

async function loadSdk() {
  const [{ createCofheClient, createCofheConfig }, { arbSepolia }] =
    await Promise.all([
      import('@cofhe/sdk/web'),
      import('@cofhe/sdk/chains'),
    ]);
  return { createCofheClient, createCofheConfig, arbSepolia };
}

async function loadValidationUtils() {
  const { ValidationUtils } = await import('@cofhe/sdk/permits');
  return ValidationUtils;
}

// ── Ephemeral EOA plumbing ──────────────────────────────────────────

function buildEphemeralWalletClient(privateKey: `0x${string}`): WalletClient {
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({
    account,
    chain: ARB_SEPOLIA_CHAIN,
    transport: http(getRpcUrl()),
  });
}

function ensureEphemeralKey(): {
  privateKey: `0x${string}`;
  address: Address;
} {
  if (!ephemeralPrivateKey || !ephemeralAddress) {
    ephemeralPrivateKey = generatePrivateKey();
    ephemeralAddress = privateKeyToAccount(ephemeralPrivateKey).address;
  }
  return { privateKey: ephemeralPrivateKey, address: ephemeralAddress };
}

/**
 * Return the current session's ephemeral EOA address. Materialises the
 * key on first call. Callers pass this as the trailing `ephemeralEOA`
 * arg on every Wave 3.5 mutation per ADR-021.
 */
export function getEphemeralEOA(): Address {
  return ensureEphemeralKey().address;
}

// ── Init ────────────────────────────────────────────────────────────

/**
 * Idempotent cofhe-client init. First call kicks off the connect +
 * permit ceremony; concurrent callers share the in-flight promise.
 * Subsequent calls after success return the cached client.
 *
 * Throws if the SDK chunks fail to load (offline / CSP blocked) or
 * if the permit-create EIP-712 sign fails. The ephemeral EOA can't
 * cancel the sign (no user-facing dialog) — `createSelfPermit` is
 * fully programmatic.
 */
export async function getCofheClient(): Promise<CofheClient> {
  if (cofheClient) return cofheClient;
  if (initPromise) return initPromise;
  initPromise = doInitialize();
  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

async function doInitialize(): Promise<CofheClient> {
  const publicClient = getPublicClient();
  const { privateKey } = ensureEphemeralKey();
  const ephemeralWalletClient = buildEphemeralWalletClient(privateKey);

  const { createCofheClient, createCofheConfig, arbSepolia } = await loadSdk();
  const config = createCofheConfig({ supportedChains: [arbSepolia] });
  const client = createCofheClient(config);

  await client.connect(
    publicClient as unknown as Parameters<typeof client.connect>[0],
    ephemeralWalletClient as unknown as Parameters<typeof client.connect>[1],
  );

  await ensureFreshSelfPermit(client);

  cofheClient = client;
  return client;
}

/**
 * Refresh the active self-permit if expired. The SDK's
 * `getOrCreateSelfPermit` returns expired permits as-is (per the
 * Fhenix dev's own warning + memory `feedback_cofhe_permit_expiration_unchecked`).
 * Expiration is then sprung at decrypt-time. This wrapper closes the
 * gap: ask for the active permit, check expiry, drop + recreate if
 * stale. The buyer page never decrypts directly, but the SDK's
 * `encryptInputs` permit path uses the same primitive — keep it fresh.
 */
async function ensureFreshSelfPermit(client: CofheClient): Promise<void> {
  const ValidationUtils = await loadValidationUtils();
  const permit = await client.permits.getOrCreateSelfPermit();
  if (!ValidationUtils.isExpired(permit)) return;
  // Permit is in the active slot but its `expiration` is in the past.
  // Drop the stale active hash + mint a fresh permit. The ephemeral
  // EOA signs synchronously; no user-facing dialog.
  client.permits.removeActivePermit();
  await client.permits.createSelf({ issuer: getEphemeralEOA() });
}

/**
 * Test seam — reset the module-level singletons. Vitest can call this
 * in `beforeEach` to get a fresh cofhe state per test.
 */
export function __resetCofheForTests(): void {
  cofheClient = null;
  initPromise = null;
  ephemeralPrivateKey = null;
  ephemeralAddress = null;
}

export type { CofheClient };
export { type PublicClient };
