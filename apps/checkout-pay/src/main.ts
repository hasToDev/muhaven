/**
 * Hosted-checkout buyer page — Wave 4 P5.
 *
 * Flow:
 *  1. Parse `/c/<sessionId>#k=<key>` from the URL.
 *  2. Lookup the session; client-side decrypt the payload.
 *  3. Render the issuer label + amount + memo + status pill.
 *  4. Subscribe to the SSE channel for status updates.
 *  5. On `Continue with passkey`, run the ZeroDev passkey ceremony to
 *     provision a kernel + capture the address.
 *  6. Show the funding step (faucet redirect — pluggable provider).
 *  7. On confirmed funding, call `transition` with `funded`.
 *  8. (Wave 4 mock — wrap + buy) on the buyer's confirmation, transition
 *     `wrapped` then `purchased`. Real ZeroDev UserOps land in Wave 5.
 *
 * Wave 4 ships the SHELL + the privacy-load-bearing pieces (URL parse,
 * fragment-key decrypt, SSE channel, signed webhooks). The on-chain
 * transactions inside the wrap+buy step run against
 * `Subscription.purchase` via the existing MuHaven SDK; that wiring
 * lands in Wave 5 alongside the real fiat on-ramp swap. For the
 * hackathon demo, the buyer page renders the steps and uses the SSE
 * channel to verify backend transitions.
 *
 * Production trajectory: the ZeroDev passkey ceremony reuses the same
 * RP ID as the dashboard (locked decision in PROGRESS.md §"Phase P5"),
 * so the kernel provisioned here is recoverable from the dashboard
 * once the buyer logs in. RP ID is configured ONCE on the ZeroDev
 * project page — no code-level config.
 */

import { BackendError, CheckoutBackend, type CheckoutSessionDto } from './backend.js';
import { decryptPayload, formatUsd6, type CheckoutPayload } from './decrypt.js';
import { parseCheckoutLocation } from './fragment.js';
import {
  FaucetRedirectProvider,
  type FundingProvider,
} from './funding-provider.js';
import { FundingPoller } from './funding-poll.js';
import { connectOrCreate, PasskeyError } from './passkey.js';
import type { KernelAccountClient } from '@zerodev/sdk';
import { isAddress, type Address } from 'viem';

interface PageState {
  session: CheckoutSessionDto;
  payload: CheckoutPayload;
  buyerAddress: string | null;
  /** Wave-5 buyer-side port (P1): live kernel client after a successful
   *  passkey ceremony. Reused by P2's funding poll (to read the kernel
   *  address) and P3's wrap+approve+buy UserOps. Null before the
   *  ceremony completes. */
  kernelClient: KernelAccountClient | null;
}

const backend = new CheckoutBackend();
const fundingProvider: FundingProvider = new FaucetRedirectProvider();

/**
 * Wave 5 buyer-side port (P2): module-level FundingPoller so the
 * interval is single-instance per page. Two SSE events firing
 * `showFundingStep` in rapid succession reuse the same poller via
 * `ensureFundingPollerStarted`'s key check — no stacked intervals.
 */
let fundingPoller: FundingPoller | null = null;
/** Key = `${buyerAddress}:${amountUsd6}` — restart only when the
 *  buyer or required amount changes (in practice neither does
 *  mid-session, but the guard keeps the design forward-compatible
 *  with P3's wrap+approve+buy retry logic). */
let fundingPollerKey: string | null = null;

bootstrap().catch((err) => {
  console.error('checkout bootstrap failed', err);
  showError(err instanceof Error ? err.message : 'Unknown error');
});

async function bootstrap(): Promise<void> {
  showSection('loading');
  // Wave 5 buyer-side port (P1): operator surfaced that the
  // `<span class="environment">` chip in the header was rendering empty.
  // Populate from hostname so stage / preview deployments don't get
  // mistaken for prod in screenshots.
  populateEnvironmentChip();

  const loc = parseCheckoutLocation(window.location);
  if (!loc) {
    showError('This URL is malformed. Check that you copied the full link including the part after "#".');
    return;
  }

  const session = await backend.lookupSession(loc.sessionId).catch((err) => {
    showError(err instanceof Error ? err.message : 'Could not load session');
    return null;
  });
  if (!session) return;

  const payload = await decryptPayload(session.encPayload, loc.fragmentKey).catch((err) => {
    showError(`Couldn't decrypt this session: ${err instanceof Error ? err.message : err}`);
    return null;
  });
  if (!payload) return;

  const state: PageState = {
    session,
    payload,
    buyerAddress: session.buyerAddress,
    kernelClient: null,
  };
  renderSession(state);
  subscribeToEvents(state);
}

function showSection(state: 'loading' | 'error' | 'checkout'): void {
  const app = document.getElementById('app');
  if (app) app.dataset.state = state;
  for (const id of ['loading', 'error', 'checkout']) {
    const el = document.getElementById(id);
    if (el) el.hidden = id !== state;
  }
}

function showError(detail: string): void {
  showSection('error');
  const el = document.querySelector<HTMLElement>('#error .error-detail');
  if (el) el.textContent = detail;
}

function renderSession(state: PageState): void {
  showSection('checkout');

  const issuerLabel = state.session.metadata.issuerLabel ?? truncateAddress(state.session.metadata.issuerAddress);
  const issuerName = document.querySelector<HTMLElement>('.issuer .name');
  if (issuerName) issuerName.textContent = issuerLabel;

  const amount = document.querySelector<HTMLElement>('.amount-block .amount');
  if (amount) amount.textContent = formatUsd6(state.payload.amountUsd6);

  const symbol = document.querySelector<HTMLElement>('.amount-block .symbol');
  if (symbol) symbol.textContent = state.session.metadata.tokenSymbol;

  const memo = document.querySelector<HTMLElement>('.memo');
  if (memo) memo.textContent = state.payload.memo ?? state.session.metadata.description;

  updateStatusPill(state.session.status);
  showStepForStatus(state);
  wireCtas(state);
}

function updateStatusPill(status: string): void {
  const pill = document.querySelector<HTMLElement>('.status-pill');
  if (!pill) return;
  pill.dataset.status = status;
  pill.textContent = humanStatus(status);
}

function humanStatus(status: string): string {
  switch (status) {
    case 'pending':
      return 'Awaiting passkey';
    case 'funded':
      return 'Funded — ready to wrap';
    case 'wrapped':
      return 'Wrapped — ready to buy';
    case 'purchased':
      return 'Purchase submitted';
    case 'settled':
      return 'Done';
    case 'expired':
      return 'Expired';
    case 'failed':
      return 'Failed';
    default:
      return status;
  }
}

const STEPS_BY_STATUS: Record<string, string> = {
  pending: 'step-pending',
  funded: 'step-wrapped',
  wrapped: 'step-wrapped',
  purchased: 'step-purchased',
  settled: 'step-settled',
  expired: 'step-failed',
  failed: 'step-failed',
};

function showStepForStatus(state: PageState): void {
  const target = STEPS_BY_STATUS[state.session.status];
  const steps = document.querySelectorAll<HTMLElement>('.step');
  for (const step of steps) {
    step.hidden = step.id !== target;
  }

  // Funded shows a funding panel BEFORE the buy step.
  if (state.session.status === 'pending' && state.buyerAddress) {
    // Buyer already linked but not yet funded — render the funding step
    // ahead of the pending passkey CTA.
    showFundingStep(state);
  }
}

function wireCtas(state: PageState): void {
  const passkey = document.getElementById('cta-passkey');
  if (passkey) {
    passkey.addEventListener('click', () => onPasskeyContinue(state));
  }
  const buy = document.getElementById('cta-buy');
  if (buy) {
    buy.addEventListener('click', () => onConfirmBuy(state));
  }
}

async function onPasskeyContinue(state: PageState): Promise<void> {
  // Wave 5 buyer-side port (P1): real ZeroDev passkey ceremony via the
  // shared stage project. `connectOrCreate` tries login first
  // (returning buyer with an existing credential) and falls back to
  // register on no-credential — single button, two paths.
  //
  // Operator-side prereq (LANDED 2026-05-1?): the stage ZeroDev project
  // has `https://pay-stage.muhaven.app` added to Domains. Without that,
  // the WebAuthn server 401s.
  const ctaPasskey = document.getElementById('cta-passkey');
  const ctaPasskeyLabel = ctaPasskey?.textContent ?? null;
  setPasskeyCtaState(ctaPasskey, 'busy', 'Signing in with passkey…');
  try {
    const kernel = await connectOrCreate();
    state.kernelClient = kernel.kernelClient;
    state.buyerAddress = kernel.address;
    showFundingStep(state);
  } catch (err) {
    if (err instanceof PasskeyError && err.code === 'passkey_cancelled') {
      // User cancelled — leave the CTA enabled so they can retry.
      setPasskeyCtaState(ctaPasskey, 'idle', ctaPasskeyLabel ?? 'Continue with passkey');
      return;
    }
    const msg = err instanceof Error ? err.message : 'Passkey sign-in failed.';
    showError(`Couldn't sign in with passkey: ${msg}`);
    setPasskeyCtaState(ctaPasskey, 'idle', ctaPasskeyLabel ?? 'Continue with passkey');
  }
}

function setPasskeyCtaState(
  el: HTMLElement | null,
  state: 'idle' | 'busy',
  label: string,
): void {
  if (!el) return;
  el.textContent = label;
  if (state === 'busy') {
    el.setAttribute('aria-busy', 'true');
    (el as HTMLButtonElement).disabled = true;
  } else {
    el.removeAttribute('aria-busy');
    (el as HTMLButtonElement).disabled = false;
  }
}

function showFundingStep(state: PageState): void {
  if (!state.buyerAddress) return;
  const stepFunding = document.getElementById('step-funding');
  if (!stepFunding) return;
  // Mount the funding provider under the existing CTA block.
  const slot = stepFunding.querySelector('#wallet-address');
  if (slot && slot.textContent !== state.buyerAddress) {
    slot.textContent = state.buyerAddress;
  }
  // Hide the pending step (the page is past sign-in now).
  const stepPending = document.getElementById('step-pending');
  if (stepPending) stepPending.hidden = true;
  stepFunding.hidden = false;
  // Render the pluggable provider into the funding container — replaces
  // the legacy faucet snippet on each transition so the swap to a Wave
  // 5 onramp provider is a one-component change.
  const existing = stepFunding.querySelector('[data-funding-slot]');
  if (existing) existing.remove();
  const slotEl = document.createElement('div');
  slotEl.setAttribute('data-funding-slot', '');
  const rendered = fundingProvider.render({
    buyerAddress: state.buyerAddress,
    payload: state.payload,
    issuerLabel: state.session.metadata.issuerLabel,
  });
  slotEl.appendChild(rendered.fragment);
  stepFunding.appendChild(slotEl);
  // Wave 5 buyer-side port (P2): start (or reuse) the USDC balance
  // poller. Idempotent — re-entry from SSE events with the same
  // buyer + amount does NOT restart the interval.
  ensureFundingPollerStarted(state);
}

function ensureFundingPollerStarted(state: PageState): void {
  if (!state.buyerAddress) return;
  if (!isAddress(state.buyerAddress)) {
    // Belt-and-braces: backend DTO types this `string | null`, kernel
    // ceremony returns a viem `Address`. If a malformed value ever
    // landed here, viem would surface it as an opaque `readContract`
    // failure every 5 s — surface the configuration error instead.
    console.error('checkout: buyerAddress is not a valid hex address', state.buyerAddress);
    setPollStatusError(
      'Your account address looks malformed. Refresh to retry — if this persists, contact the issuer.',
    );
    return;
  }
  const buyer = state.buyerAddress;
  const required = (() => {
    try {
      return BigInt(state.payload.amountUsd6);
    } catch {
      return null;
    }
  })();
  if (required === null) {
    console.error(
      'checkout: amountUsd6 not a parseable bigint',
      state.payload.amountUsd6,
    );
    return;
  }
  const key = `${buyer.toLowerCase()}:${required.toString()}`;
  if (fundingPollerKey === key && fundingPoller?.isRunning) {
    // Already polling the same kernel for the same target — no-op.
    return;
  }
  fundingPoller?.stop();
  fundingPoller = new FundingPoller({
    onPoll: (balance) => {
      updatePollStatus(balance, required);
    },
    onFunded: async () => {
      // Drop the "checking…" copy in favour of a settled affordance —
      // the SSE channel will flip the page to step 3 shortly. Showing
      // a green tick here closes the gap.
      markPollStatusFunded();
      await commitFundedTransition(state, buyer);
    },
    onError: (err) => {
      // Transient RPC blips — log only. The next interval will retry.
      console.warn('USDC balance poll failed (will retry)', err);
    },
  });
  fundingPollerKey = key;
  fundingPoller.start(buyer, required);
}

function stopFundingPoller(): void {
  fundingPoller?.stop();
  fundingPoller = null;
  fundingPollerKey = null;
}

function updatePollStatus(balance: bigint, required: bigint): void {
  const el = document.querySelector<HTMLElement>('[data-funding-poll-status]');
  if (!el) return;
  const formatted = formatUsd6(balance.toString());
  const requiredFormatted = formatUsd6(required.toString());
  // onPoll fires synchronously before onFunded inside the same tick.
  // When the threshold has just been crossed, render a transient
  // "confirming" message instead of the misleading "waiting for ≥ X"
  // copy. `markPollStatusFunded` then overrides to "Funded — preparing
  // the next step…" once the transition resolves.
  if (balance >= required) {
    el.textContent = `Current balance: ${formatted} USDC — confirming with the backend…`;
    el.dataset.pollState = 'funded';
  } else {
    el.textContent = `Current balance: ${formatted} USDC — waiting for ≥ ${requiredFormatted}`;
    el.dataset.pollState = 'waiting';
  }
}

function markPollStatusFunded(): void {
  const el = document.querySelector<HTMLElement>('[data-funding-poll-status]');
  if (!el) return;
  el.textContent = 'Funded — preparing the next step…';
  el.dataset.pollState = 'funded';
}

function setPollStatusError(message: string): void {
  const el = document.querySelector<HTMLElement>('[data-funding-poll-status]');
  if (!el) return;
  el.textContent = message;
  el.dataset.pollState = 'error';
}

/**
 * Commit the `funded` transition with bounded retries.
 *
 * The buyer's kernel observably crosses the threshold (we just polled
 * a balance ≥ required). The only thing that can fail is the
 * backend round-trip. Three outcomes:
 *  - 2xx: done.
 *  - 409 Conflict: benign — `transition-session.use-case.ts` throws
 *    `conflict` for terminal state, expired pending, invalid forward
 *    transition, OR lost race. All four reduce to "the row is no
 *    longer in pending" → the page is already advancing via SSE.
 *  - Other 4xx: deterministic — retrying won't help. Surface
 *    immediately so the user / operator sees the cause.
 *  - 5xx / network: transient — retry with backoff (0 / 1.5s / 4s).
 *
 * Failure is NOT fatal to the page: the rest of the UI stays usable
 * (kernel address visible, faucet link works) and we surface a retry
 * hint inline. The user can refresh to re-poll + re-attempt.
 */
async function commitFundedTransition(
  state: PageState,
  buyer: Address,
): Promise<void> {
  const delays = [0, 1500, 4000] as const;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    const delay = delays[attempt] ?? 0;
    if (delay > 0) {
      // Second/third attempts can sit silent for up to 5.5 s combined.
      // Swap the "preparing the next step…" copy for an honest "still
      // confirming" so the user doesn't read the pause as a freeze.
      setPollStatusRetrying(attempt + 1, delays.length);
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      await backend.transition({
        sessionId: state.session.sessionId,
        newStatus: 'funded',
        buyerAddress: buyer,
      });
      return;
    } catch (err) {
      if (err instanceof BackendError && err.status === 409) {
        // SSE channel beat us — the page is already advancing.
        console.warn('transition(funded) raced with backend (409) — ignoring');
        return;
      }
      const deterministicClientError =
        err instanceof BackendError && err.status >= 400 && err.status < 500;
      const lastAttempt = attempt === delays.length - 1;
      if (deterministicClientError || lastAttempt) {
        console.error('checkout transition(funded) failed', err);
        setPollStatusError(
          `Couldn't confirm your deposit with the backend (${
            err instanceof Error ? err.message : String(err)
          }). Refresh to retry — your funds are safe in your kernel address above.`,
        );
        return;
      }
      console.warn(
        `transition(funded) attempt ${attempt + 1} failed — retrying`,
        err,
      );
    }
  }
}

function setPollStatusRetrying(attempt: number, total: number): void {
  const el = document.querySelector<HTMLElement>('[data-funding-poll-status]');
  if (!el) return;
  el.textContent = `Confirming with the backend… (retry ${attempt}/${total})`;
  el.dataset.pollState = 'funded';
}

async function onConfirmBuy(state: PageState): Promise<void> {
  // Wave 4 placeholder — the real wrap+buy UserOp ceremony lands in
  // Wave 5. For the hackathon demo, the page reports `purchased` with
  // a synthetic tx hash so the SSE + webhook plumbing exercises end-
  // to-end.
  const fakeTxHash = `0x${'demo'.padEnd(64, '0')}` as const;
  await backend
    .transition({
      sessionId: state.session.sessionId,
      newStatus: 'purchased',
      purchaseTxHash: fakeTxHash,
    })
    .catch((err) => {
      console.error('purchase transition failed', err);
      showError(`Purchase failed: ${err instanceof Error ? err.message : err}`);
    });
}

function subscribeToEvents(state: PageState): void {
  const source = backend.openEventStream(state.session.sessionId);
  const onUpdate = (status: string, data: { buyerAddress?: string | null; purchaseTxHash?: string | null } = {}) => {
    state.session = { ...state.session, status, ...data } as CheckoutSessionDto;
    if (data.buyerAddress) state.buyerAddress = data.buyerAddress;
    updateStatusPill(status);
    showStepForStatus(state);
    // Wave 5 buyer-side port (P2): once the session has progressed
    // beyond pending, the kernel either deposited the USDC we were
    // waiting for OR the backend wrote it directly. Either way, the
    // poll loop has no work left — stop the interval so we don't
    // burn RPC quota on a session that's already advancing.
    if (status !== 'pending') {
      stopFundingPoller();
    }
    if (status === 'settled' || status === 'expired' || status === 'failed') {
      source.close();
    }
  };
  source.addEventListener('snapshot', (event: MessageEvent) => {
    try {
      const parsed = JSON.parse(event.data);
      onUpdate(parsed.status, parsed);
    } catch (err) {
      console.warn('snapshot parse failed', err);
    }
  });
  for (const eventType of [
    'pending',
    'funded',
    'wrapped',
    'purchased',
    'settled',
    'expired',
    'failed',
  ]) {
    source.addEventListener(eventType, (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data);
        onUpdate(parsed.data?.status ?? eventType, parsed.data ?? {});
      } catch (err) {
        console.warn('event parse failed', err);
      }
    });
  }
  source.addEventListener('error', () => {
    // EventSource auto-reconnects per the `retry:` line; we just log.
    console.warn('SSE connection blip — reconnecting');
  });
}

function truncateAddress(addr: string): string {
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Populate the header `<span class="environment">` chip from the
 * hostname. Stage / preview deploys label themselves so they don't
 * get mistaken for prod in screenshots / bug reports.
 *
 * Production (`pay.muhaven.app`) renders no chip — empty span.
 */
function populateEnvironmentChip(): void {
  const el = document.querySelector<HTMLElement>('.brand .environment');
  if (!el) return;
  const host = window.location.hostname.toLowerCase();
  let label: string;
  if (host === 'pay.muhaven.app') label = '';
  else if (host === 'pay-stage.muhaven.app') label = 'stage';
  else if (host === 'localhost' || host === '127.0.0.1') label = 'local';
  else label = 'preview';
  el.textContent = label;
}
