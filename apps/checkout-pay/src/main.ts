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
import {
  executePurchase,
  type PurchaseProgress,
  type PurchaseStage,
} from './purchase.js';
import { getCofheClient } from './cofhe.js';
import type { KernelAccountClient } from '@zerodev/sdk';
import { getAddress, isAddress, type Address } from 'viem';

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
/**
 * Wave 5 buyer-side port (P2 a11y): last poll-status state announced
 * to the screen-reader live region. The visible status element
 * updates every 5 s (balance ticks), but we only push to the
 * `role="status"` / `role="alert"` regions on STATE TRANSITIONS to
 * avoid the every-5s announce spam (WCAG 4.1.3 anti-pattern). The
 * dedupe key includes a per-state nonce for the retry case (so each
 * `attempt 2 of 3 → attempt 3 of 3` transition is announced), which
 * is why the cache is typed `string` rather than the narrower
 * PollAnnounceState union.
 */
type PollAnnounceState = 'idle' | 'waiting' | 'crossed' | 'funded' | 'retry' | 'error';
let lastAnnouncedPollState: string = 'idle';
/** Tracks the last status delivered by the SSE channel so we can
 *  detect transitions (pending → funded → wrapped → …) and move
 *  focus to the new step heading exactly once per transition. */
let lastSseStatus: string | null = null;
/**
 * Wave 5 buyer-side port (P2 third-pass): AbortController paired with
 * the active FundingPoller so a `stopFundingPoller()` call (triggered
 * by an SSE status transition) ALSO cancels any in-flight
 * `commitFundedTransition` retry loop. Without this, a backoff sleep
 * (up to 4 s) followed by a 5xx response would write a misleading
 * "Couldn't confirm your deposit" error to the assertive sr-only
 * alert region — even though the page has already advanced to step 3.
 */
let fundingCommitAc: AbortController | null = null;

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

/**
 * Statuses where the user CAN'T proceed without a live `kernelClient`
 * (Confirm purchase fires 6 UserOps via the kernel). On a fresh page
 * load (or reload) at one of these states, JS-memory `kernelClient`
 * is null even though the backend session is past `pending`.
 *
 * Without this guard, `step-wrapped` rendered with the Confirm
 * purchase CTA enabled — taps would fail at the `if (!state.kernelClient)`
 * check in `onConfirmBuy` with a confusing "Kernel client not ready"
 * full-page error. Fix: re-show step-pending when status is in this
 * set AND kernel is null, so the user re-runs the passkey ceremony
 * to re-provision the kernel before reaching the buy step.
 *
 * `pending` is excluded — step-pending is what we'd show anyway.
 * `purchased` and terminal states (`settled` / `expired` / `failed`)
 * don't need the kernel (no more UserOps required), so they render
 * correctly without it.
 */
const STATUSES_NEEDING_KERNEL = new Set(['funded', 'wrapped']);

function showStepForStatus(state: PageState): void {
  // Wave 5 P3 post-cutover hot-fix (2026-05-14): handle the
  // "page reloaded after passkey + funded but before purchase" case.
  // The session row is past `pending` on the backend, but
  // `state.kernelClient` is null because passkey-provisioned kernels
  // don't survive a page reload. Re-show step-pending so the user
  // re-runs the passkey ceremony; `onPasskeyContinue` then dispatches
  // back to `showStepForStatus(state)` which will advance to
  // step-wrapped (or wherever) with the kernel now populated.
  const status = state.session.status;
  const needsKernelAndMissing =
    STATUSES_NEEDING_KERNEL.has(status) && !state.kernelClient;
  const effectiveTarget = needsKernelAndMissing
    ? 'step-pending'
    : STEPS_BY_STATUS[status];

  const steps = document.querySelectorAll<HTMLElement>('.step');
  for (const step of steps) {
    step.hidden = step.id !== effectiveTarget;
  }

  // Funded shows a funding panel BEFORE the buy step.
  if (status === 'pending' && state.buyerAddress) {
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
    // Wave 5 P3 post-cutover hot-fix (2026-05-14): dispatch through
    // showStepForStatus so we advance to whatever step the CURRENT
    // backend status maps to (not always step-funding). Reload-after-
    // funded scenario: status is `funded`, kernel is now set, this
    // call advances directly to step-wrapped (Confirm purchase).
    // Prior code unconditionally called `showFundingStep(state)`
    // which forced step-funding even when the session was already
    // past funded — caused the user to see the faucet panel + funding
    // poll RE-ARM unnecessarily after a reload-then-passkey flow.
    showStepForStatus(state);
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
  // Wave 5 buyer-side port (P2 third-pass): idempotent rebuild. Without
  // the buyer-match guard, every redundant SSE `pending` snapshot (e.g.
  // EventSource auto-reconnects after a tab sleep) would `existing.remove()`
  // + recreate, wiping any "Confirming with the backend… (attempt 2 of 3)"
  // or balance-tick text the poller had written to
  // `[data-funding-poll-status]`. Track the buyer that owns the current
  // slot via `data-buyer-address`; rebuild only when missing or stale.
  const existing = stepFunding.querySelector('[data-funding-slot]');
  const existingBuyer = existing?.getAttribute('data-buyer-address');
  if (!existing || existingBuyer !== state.buyerAddress) {
    if (existing) existing.remove();
    const slotEl = document.createElement('div');
    slotEl.setAttribute('data-funding-slot', '');
    slotEl.setAttribute('data-buyer-address', state.buyerAddress);
    const rendered = fundingProvider.render({
      buyerAddress: state.buyerAddress,
      payload: state.payload,
      issuerLabel: state.session.metadata.issuerLabel,
    });
    slotEl.appendChild(rendered.fragment);
    stepFunding.appendChild(slotEl);
  }
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
  // Wave 5 buyer-side port (P2 third-pass): canonicalise via
  // `getAddress` so a backend-supplied lowercase address (DTO) and a
  // kernel-supplied checksummed address (viem) produce the same cache
  // key. Without this, two same-buyer re-entries with different cases
  // would build different keys → unnecessary `stop()` + `new` churn.
  const buyer = getAddress(state.buyerAddress);
  // Parse + validate the required amount. `BigInt('-1000000')` succeeds
  // (yielding a negative bigint), which would make `balance >= required`
  // trivially true and auto-fire onFunded against any balance — a
  // malicious issuer payload could weaponise this. `BigInt('0xFF')` and
  // `BigInt(' 100 ')` also succeed and would mismatch the cache key.
  // Pre-validate against a strict decimal-digit regex and reject
  // negatives + zero + impossible-magnitude values (USDC is 6-decimal
  // uint64 in practice; we use the uint64 max as a sane upper bound).
  // Third-pass: ALSO reject `0n`. `BigInt('0')` passes the regex + the
  // `< 0n` check, but `balance >= 0n` is trivially true → onFunded fires
  // on tick 1 against any balance. Defense-in-depth — backend should
  // validate amountUsd6 > 0 server-side, but corrupt sessions shouldn't
  // weaponise the buyer page either.
  const required = (() => {
    const raw = state.payload.amountUsd6;
    if (!/^[0-9]+$/.test(raw)) return null;
    try {
      const v = BigInt(raw);
      if (v <= 0n) return null;
      if (v > 18_446_744_073_709_551_615n) return null;
      return v;
    } catch {
      return null;
    }
  })();
  if (required === null) {
    console.error(
      'checkout: amountUsd6 missing or not a positive decimal integer ≤ uint64 max',
      state.payload.amountUsd6,
    );
    setPollStatusError(
      'This checkout link has an invalid amount. Ask the issuer for a fresh link.',
    );
    return;
  }
  const key = `${buyer.toLowerCase()}:${required.toString()}`;
  if (fundingPollerKey === key && fundingPoller?.isRunning) {
    // Already polling the same kernel for the same target — no-op.
    return;
  }
  fundingPoller?.stop();
  // Wave 5 buyer-side port (P2 third-pass): abort any prior in-flight
  // commit retry before starting a new poller — the new run owns the
  // confirmation contract from here on.
  fundingCommitAc?.abort();
  fundingCommitAc = new AbortController();
  const commitSignal = fundingCommitAc.signal;
  fundingPoller = new FundingPoller({
    onPoll: (balance) => {
      updatePollStatus(balance, required);
    },
    onFunded: async () => {
      // Drop the "checking…" copy in favour of a settled affordance —
      // the SSE channel will flip the page to step 3 shortly. Showing
      // a green tick here closes the gap.
      markPollStatusFunded();
      await commitFundedTransition(state, buyer, commitSignal);
    },
    onError: (err) => {
      // Transient RPC blips — log a sanitised shape only. Viem errors
      // embed the request body (kernel address + USDC contract +
      // RPC URL) in `message`; surfacing them verbatim writes the
      // buyer's address to the browser console history. Strip 0x-
      // addresses before logging so a shared-device replay doesn't
      // surface them. The next interval will retry the read.
      console.warn('USDC balance poll failed (will retry)', summariseError(err));
    },
  });
  fundingPollerKey = key;
  fundingPoller.start(buyer, required);
}

function stopFundingPoller(): void {
  fundingPoller?.stop();
  fundingPoller = null;
  fundingPollerKey = null;
  // Wave 5 buyer-side port (P2 third-pass): cancel any in-flight
  // commit retry. Without this, a `funded`/`wrapped` SSE flip mid-
  // backoff (4 s sleep) followed by a 5xx response would write a
  // misleading `setPollStatusError` to the assertive sr-only alert
  // region even though the page has already advanced.
  fundingCommitAc?.abort();
  fundingCommitAc = null;
  // Reset announce dedupe so a future re-entry (e.g. an in-page
  // session-switch by a future Wave-5 "Cancel and try a different
  // link" affordance) gets a clean "waiting" announcement.
  //
  // NB: `lastSseStatus` is NOT reset here. It's a module-level
  // singleton that the SSE-handler reads to detect transitions; the
  // handler captures `prevStatus = lastSseStatus` BEFORE calling
  // `stopFundingPoller`, then writes `lastSseStatus = status` AFTER,
  // so any reset here is immediately overwritten on the same SSE
  // event. For the (currently nonexistent) "Cancel and try a
  // different link" path that wants a fresh session, reset
  // `lastSseStatus` there explicitly — it's not the funding poll's
  // concern.
  resetPollAnnounceState();
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
    // The threshold-crossed state is a meaningful transition — announce
    // once. Subsequent ticks observing the same state are silent.
    announceStateTransition('crossed', 'Deposit detected. Confirming with the backend.');
  } else {
    el.textContent = `Current balance: ${formatted} USDC — waiting for ≥ ${requiredFormatted}`;
    el.dataset.pollState = 'waiting';
    // First time the page enters the waiting state — announce. Subsequent
    // balance ticks (still waiting, just bigger / smaller balance) do
    // NOT re-announce; the visible text updates silently.
    announceStateTransition('waiting', `Waiting for at least ${requiredFormatted} USDC at your account address.`);
  }
}

function markPollStatusFunded(): void {
  const el = document.querySelector<HTMLElement>('[data-funding-poll-status]');
  if (!el) return;
  el.textContent = 'Funded — preparing the next step…';
  el.dataset.pollState = 'funded';
  announceStateTransition('funded', 'Funded. Preparing the next step.');
}

function setPollStatusError(message: string): void {
  const el = document.querySelector<HTMLElement>('[data-funding-poll-status]');
  if (!el) return;
  el.textContent = message;
  el.dataset.pollState = 'error';
  // Terminal failure routes through the assertive `role="alert"`
  // region so screen-reader users are interrupted (WCAG 3.3.1).
  announceAlert(message);
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
  signal: AbortSignal,
): Promise<void> {
  const delays = [0, 1500, 4000] as const;
  // 408 Request Timeout / 425 Too Early / 429 Too Many Requests are
  // transient client-status responses where retrying makes sense.
  // Other 4xx codes (400 / 401 / 403 / 404 / 405 / 410 / 422 …) mean
  // retrying won't help — bail and surface immediately.
  const TRANSIENT_CLIENT_STATUSES = new Set([408, 425, 429]);
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    // Third-pass abort points: check before sleep + before fetch. If
    // the caller (typically the SSE-driven `stopFundingPoller`)
    // aborted us, exit silently — the page state is already advancing
    // and any UI write here would be misleading.
    if (signal.aborted) return;
    const delay = delays[attempt] ?? 0;
    if (delay > 0) {
      // Second/third attempts can sit silent for up to 5.5 s combined.
      // Swap the "preparing the next step…" copy for an honest "still
      // confirming" so the user doesn't read the pause as a freeze.
      setPollStatusRetrying(attempt + 1, delays.length);
      const aborted = await sleepWithAbort(delay, signal);
      if (aborted) return;
    }
    if (signal.aborted) return;
    try {
      await backend.transition({
        sessionId: state.session.sessionId,
        newStatus: 'funded',
        buyerAddress: buyer,
      });
      return;
    } catch (err) {
      // Re-check abort: the transition POST may have resolved AFTER
      // an abort fired (network in flight when SSE flipped status).
      // Don't surface the error in that case — the page already moved.
      if (signal.aborted) return;
      if (err instanceof BackendError && err.status === 409) {
        // SSE channel beat us — the page is already advancing.
        console.warn('transition(funded) raced with backend (409) — ignoring');
        return;
      }
      const deterministicClientError =
        err instanceof BackendError &&
        err.status >= 400 &&
        err.status < 500 &&
        !TRANSIENT_CLIENT_STATUSES.has(err.status);
      const lastAttempt = attempt === delays.length - 1;
      if (deterministicClientError || lastAttempt) {
        console.error(
          'checkout transition(funded) failed',
          summariseError(err),
        );
        // User-facing message: drop the raw error tail to avoid
        // surfacing the kernel address in any UI that copy-pastes
        // text content (e.g. screen-reader speech logs, support
        // tickets). The console log carries the redacted detail.
        const status =
          err instanceof BackendError ? ` (HTTP ${err.status})` : '';
        setPollStatusError(
          `Couldn't confirm your deposit with the backend${status}. Refresh to retry — your funds are safe in your kernel address above.`,
        );
        return;
      }
      console.warn(
        `transition(funded) attempt ${attempt + 1} failed — retrying`,
        summariseError(err),
      );
    }
  }
}

/**
 * Sleep that honours `AbortSignal`. Returns `true` if the signal
 * fired during the sleep (caller should bail), `false` if the timer
 * elapsed normally. Uses `once: true` listener registration so the
 * abort handler is detached on first fire (no listener leak).
 */
function sleepWithAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(true);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timerId);
      resolve(true);
    };
    const timerId = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function setPollStatusRetrying(attempt: number, total: number): void {
  const el = document.querySelector<HTMLElement>('[data-funding-poll-status]');
  if (!el) return;
  // "(attempt 2 of 3)" instead of "(retry 2/3)" — the slash reads as
  // "slash" in NVDA / VoiceOver and the word "retry" doesn't help
  // here; "attempt N of M" is the natural phrasing for both visual
  // and screen-reader users. Distinct `data-poll-state='confirming'`
  // so the operator-side CSS can distinguish "amber because funded,
  // idle" from "still trying, RPC came back slow."
  el.textContent = `Confirming with the backend… (attempt ${attempt} of ${total})`;
  el.dataset.pollState = 'confirming';
  // Re-announce on each retry so SR users hear progress, but only
  // when the attempt count actually changes (announceStateTransition
  // de-dupes on the `state` key, so a per-attempt key is required).
  // We use the same `retry` state key and let the message carry the
  // attempt number — this means a 1→2 transition announces once,
  // 2→3 announces once, and a stuck attempt does NOT spam.
  announceStateTransition('retry', `Confirming, attempt ${attempt} of ${total}.`, attempt);
}

/**
 * Push a transition message to the polite `role="status"` sr-only
 * region IF the state actually changed (or a per-state nonce
 * advanced). Subsequent calls with the same state + nonce are
 * suppressed so screen readers don't re-announce the same condition
 * on every poll. The visible status element keeps updating
 * regardless — this only gates announcements.
 */
function announceStateTransition(
  state: PollAnnounceState,
  message: string,
  nonce?: number,
): void {
  const compositeKey = nonce !== undefined ? `${state}:${nonce}` : state;
  if (lastAnnouncedPollState === compositeKey) return;
  lastAnnouncedPollState = compositeKey;
  const el = document.querySelector<HTMLElement>('[data-funding-poll-announce]');
  if (!el) return;
  el.textContent = message;
}

/** Push a hard-failure message to the assertive `role="alert"`
 *  region. Interrupts the screen reader immediately (vs the polite
 *  channel which queues). Use ONLY for terminal failures.
 */
function announceAlert(message: string): void {
  const el = document.querySelector<HTMLElement>('[data-funding-poll-alert]');
  if (!el) return;
  el.textContent = message;
}

function resetPollAnnounceState(): void {
  lastAnnouncedPollState = 'idle';
  const announce = document.querySelector<HTMLElement>('[data-funding-poll-announce]');
  if (announce) announce.textContent = '';
  const alertEl = document.querySelector<HTMLElement>('[data-funding-poll-alert]');
  if (alertEl) alertEl.textContent = '';
}

/**
 * Sanitise a viem / fetch error for safe `console.warn` / `console.error`
 * logging on a shared-device tab. Viem errors embed the request body
 * (kernel address + contract address + RPC URL) in `message`,
 * `shortMessage`, and `metaMessages`. Strip any 0x-hex addresses (40
 * nibbles) before logging so a shared-device replay doesn't surface
 * them in DevTools history. The error name + a redacted message are
 * sufficient for diagnostics.
 */
interface ErrorSummary {
  name: string;
  message: string;
  shortMessage?: string;
  metaMessages?: string[];
  details?: string;
  status?: number;
}

function summariseError(err: unknown): ErrorSummary {
  if (err instanceof BackendError) {
    return {
      name: 'BackendError',
      status: err.status,
      message: redactAddresses(err.message),
    };
  }
  if (err instanceof Error) {
    const out: ErrorSummary = {
      name: err.name,
      message: redactAddresses(err.message),
    };
    // viem `BaseError` extension fields. Each may embed the kernel
    // address (in the request args / contract address), so redact
    // before surfacing. `metaMessages` is an array of human-readable
    // strings appended by the viem stack walker.
    const e = err as {
      shortMessage?: unknown;
      metaMessages?: unknown;
      details?: unknown;
    };
    if (typeof e.shortMessage === 'string') {
      out.shortMessage = redactAddresses(e.shortMessage);
    }
    if (Array.isArray(e.metaMessages)) {
      out.metaMessages = e.metaMessages
        .filter((m): m is string => typeof m === 'string')
        .map(redactAddresses);
    }
    if (typeof e.details === 'string') {
      out.details = redactAddresses(e.details);
    }
    return out;
  }
  return { name: 'unknown', message: redactAddresses(String(err)) };
}

function redactAddresses(s: string): string {
  return s.replace(/0x[a-fA-F0-9]{40}/g, '0x…REDACTED');
}

async function onConfirmBuy(state: PageState): Promise<void> {
  // Wave 5 buyer-side port (P3): real wrap+approve+buy ceremony.
  // Six on-chain UserOps via the buyer's kernel:
  //   1) USDC.approve(LegacyPusdc, amount)
  //   2) LegacyPusdc.wrap(kernel, amount)
  //   3) LegacyPusdc.setOperator(MuHavenStable, until)
  //   4) MuHavenStable.wrap(InEuint64, ephemeralEOA)
  //   5) MuHavenStable.setOperator(Subscription, until)
  //   6) Subscription.purchase(token, InEuint128, maxSharesHint, eph)
  //
  // Steps 1, 3, 5 skip when pre-checks pass (existing allowance /
  // operator grant). Steps 2, 4, 6 always run. The final tx hash from
  // step 6 is what we send to the backend as `purchaseTxHash`.
  if (!state.kernelClient) {
    showError('Kernel client not ready. Please sign in with passkey first.');
    return;
  }
  if (!state.buyerAddress || !isAddress(state.buyerAddress)) {
    showError('Buyer address is not a valid hex address. Refresh and retry.');
    return;
  }
  const tokenAddress = state.session.metadata.tokenAddress;
  if (!isAddress(tokenAddress)) {
    showError(
      `Token address is not a valid hex address (${tokenAddress}). Ask the issuer for a fresh link.`,
    );
    return;
  }
  const amountRaw = state.payload.amountUsd6;
  if (!/^[0-9]+$/.test(amountRaw)) {
    showError(
      'This checkout link has an invalid amount. Ask the issuer for a fresh link.',
    );
    return;
  }
  let amountUsd6: bigint;
  try {
    amountUsd6 = BigInt(amountRaw);
  } catch {
    showError(
      'This checkout link has an invalid amount. Ask the issuer for a fresh link.',
    );
    return;
  }
  if (amountUsd6 < 1_000_000n) {
    // Demo-NAV scaling rounds down to 0 shares below 1 USDC. Surface
    // the limit explicitly instead of letting executePurchase fail
    // with a less helpful error.
    showError(
      'Demo build: this checkout requires at least 1 USDC. Larger amounts behave normally.',
    );
    return;
  }

  setBuyCtaState('busy');
  try {
    const txHash = await executePurchase({
      kernelClient: state.kernelClient,
      buyerAddress: getAddress(state.buyerAddress),
      amountUsd6,
      tokenAddress: getAddress(tokenAddress),
      callbacks: {
        onProgress: (p) => {
          renderPurchaseProgress(p);
          // Re-announce only on stage transitions (we get one
          // onProgress per stage, so the announce dedupe by stage is
          // safe).
          announcePurchaseProgress(p);
        },
        // Backend state machine requires `funded → wrapped → purchased`.
        // Fire the intermediate `wrapped` transition after step 4 so
        // the next `purchased` POST is a valid forward step. 409 is
        // benign (SSE/P4 beat us to it). Other errors bubble up to
        // abort the ceremony — better than blasting Subscription.purchase
        // when the backend can't track the state.
        onWrappedComplete: async () => {
          try {
            await backend.transition({
              sessionId: state.session.sessionId,
              newStatus: 'wrapped',
            });
          } catch (err) {
            if (err instanceof BackendError && err.status === 409) {
              console.warn('transition(wrapped) raced with backend (409) — ignoring');
              return;
            }
            console.error('transition(wrapped) failed', summariseError(err));
            // Re-throw so executePurchase aborts before step 5/6.
            throw err;
          }
        },
      },
    });
    // Step 6's tx hash is the on-chain settlement tx. Report it to
    // the backend so the SSE channel + webhook fire `purchased` to
    // the issuer dashboard.
    try {
      await backend.transition({
        sessionId: state.session.sessionId,
        newStatus: 'purchased',
        purchaseTxHash: txHash,
      });
    } catch (err) {
      if (err instanceof BackendError && err.status === 409) {
        // Backend already advanced — likely the P4 settlement indexer
        // beat us to it. Benign.
        console.warn('transition(purchased) raced with backend (409) — ignoring');
      } else {
        console.error('purchase transition failed', err);
        announcePurchaseAlert(
          'Purchase landed on chain but the backend hand-off failed. ' +
            'Refresh in a moment — the issuer indexer will pick up your tx.',
        );
      }
    }
  } catch (err) {
    console.error('executePurchase failed', err);
    const msg =
      err instanceof Error ? err.message : 'Purchase failed for unknown reason';
    showError(`Couldn't complete the purchase: ${msg}`);
  } finally {
    // Restore the CTA whenever the ceremony exits — success path
    // gets hidden by the SSE flip anyway, but a degraded SSE channel
    // would otherwise leave the user stuck on a permanently-disabled
    // "Working…" button with no recovery short of a refresh. Symmetric
    // with the error path that USED to call setBuyCtaState('idle')
    // directly.
    setBuyCtaState('idle');
  }
}

/**
 * Push a purchase-stage hard-failure message to the dedicated
 * `[data-purchase-alert]` sr-only region (role="alert"). Separate
 * from the funding step's alert region so an end-of-ceremony failure
 * never overwrites a still-relevant funding-phase alert (and vice
 * versa). Falls back to the funding alert region as a defensive
 * shim if the purchase-alert region is missing from index.html
 * (e.g., during partial revisions of the SPA scaffold).
 */
function announcePurchaseAlert(message: string): void {
  const purchaseAlert = document.querySelector<HTMLElement>(
    '[data-purchase-alert]',
  );
  if (purchaseAlert) {
    purchaseAlert.textContent = message;
    return;
  }
  // Defensive fallback — if the dedicated region wasn't shipped, use
  // the existing funding alert so the SR user still hears the message.
  announceAlert(message);
}

/**
 * Set the buy CTA's busy / idle state. When busy, the button is
 * disabled and shows a "Working…" label; when idle, the original
 * "Confirm purchase" label is restored.
 */
function setBuyCtaState(stateName: 'idle' | 'busy'): void {
  const cta = document.getElementById('cta-buy') as HTMLButtonElement | null;
  if (!cta) return;
  if (stateName === 'busy') {
    cta.dataset.idleLabel = cta.dataset.idleLabel || cta.textContent || '';
    cta.disabled = true;
    cta.setAttribute('aria-busy', 'true');
    cta.textContent = 'Working… do not close this tab';
  } else {
    cta.disabled = false;
    cta.removeAttribute('aria-busy');
    cta.textContent = cta.dataset.idleLabel || 'Confirm purchase';
  }
}

const PURCHASE_STAGE_COPY: Record<PurchaseStage, string> = {
  approve_usdc: 'Step 1 of 6 · Authorise USDC',
  wrap_pusdc: 'Step 2 of 6 · Wrap into PUSDC',
  grant_pusdc_operator: 'Step 3 of 6 · Authorise the wrapper',
  wrap_mhusdc: 'Step 4 of 6 · Seal into confidential mhUSDC',
  grant_mhusdc_operator: 'Step 5 of 6 · Authorise Subscription',
  purchase: 'Step 6 of 6 · Buy RWA shares',
  done: 'Purchase complete',
};

/**
 * Render the current purchase stage to the buy step's progress
 * indicator. The DOM is in `index.html` under `step-wrapped`.
 */
function renderPurchaseProgress(p: PurchaseProgress): void {
  const indicator = document.querySelector<HTMLElement>(
    '[data-purchase-progress]',
  );
  if (!indicator) return;
  const headline = PURCHASE_STAGE_COPY[p.stage] ?? p.message;
  const detail = p.skipped
    ? `${p.message} — already authorised, skipping`
    : p.message;
  indicator.innerHTML = `
    <p class="purchase-progress-headline" data-purchase-stage="${escapeAttr(p.stage)}">${escapeHtml(headline)}</p>
    <p class="purchase-progress-detail">${escapeHtml(detail)}</p>
  `;
  indicator.dataset.stage = p.stage;
  indicator.dataset.step = String(p.step);
}

/** Announce purchase progress to the sr-only `[data-purchase-announce]` region
 *  on every stage advance. */
function announcePurchaseProgress(p: PurchaseProgress): void {
  const announce = document.querySelector<HTMLElement>(
    '[data-purchase-announce]',
  );
  if (!announce) return;
  const headline = PURCHASE_STAGE_COPY[p.stage] ?? p.message;
  announce.textContent = `${headline}. ${p.message}.`;
}

/** Minimal DOM-string escapers — we render trusted backend text but
 *  also dynamic stage labels, so escape defensively. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function subscribeToEvents(state: PageState): void {
  const source = backend.openEventStream(state.session.sessionId);
  const onUpdate = (status: string, data: { buyerAddress?: string | null; purchaseTxHash?: string | null } = {}) => {
    const prevStatus = lastSseStatus;
    // Third-pass: explicit field merge instead of `{...state.session,
    // status, ...data} as CheckoutSessionDto`. The `as` cast hid any
    // future SSE field that would otherwise clobber a DTO field. Only
    // merge fields we own the wire-shape contract for.
    state.session = { ...state.session, status };
    if (data.buyerAddress) {
      state.session.buyerAddress = data.buyerAddress;
      state.buyerAddress = data.buyerAddress;
    }
    if (data.purchaseTxHash) {
      state.session.purchaseTxHash = data.purchaseTxHash;
    }
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
    // Wave 5 buyer-side port (P3): pre-warm the cofhe SDK as soon as
    // the buyer reaches the buy step. The cofhe + tfhe + WASM chunks
    // total ~5.5 MB and only load on demand; firing init here means
    // the download runs in parallel while the user reads the buy CTA
    // copy, so tap-to-confirm doesn't pay the full download latency.
    // Idempotent — concurrent calls share the in-flight init promise.
    if (status === 'funded' || status === 'wrapped') {
      void getCofheClient().catch((err) => {
        // Pre-warm failure isn't fatal — `executePurchase` will retry
        // on click. Log redacted only.
        console.warn('cofhe pre-warm failed (will retry on click)', summariseError(err));
      });
    }
    // Wave 5 buyer-side port (P2 a11y): move focus to the newly-
    // revealed step heading on the FIRST observation of a status
    // transition. The h2 carries `tabindex="-1"` in index.html. Focus
    // moves announce the heading text via the SR's focus-change hook,
    // and give keyboard users a sensible next-tab anchor (the step's
    // primary CTA). Skip on the initial snapshot event (prevStatus
    // is null on first delivery) so we don't auto-focus on page load.
    if (prevStatus !== null && prevStatus !== status) {
      moveFocusToStep(status);
    }
    lastSseStatus = status;
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

/**
 * Wave 5 buyer-side port (P2 a11y): move focus to the newly-revealed
 * step heading so screen-reader users hear the level + text on the
 * focus-change hook, and keyboard users get a sensible next-tab
 * anchor. Each step's `<h2>` carries `tabindex="-1"` so it can
 * receive programmatic focus without disrupting the natural tab
 * order. Skips terminal states (settled/expired/failed) where the
 * step already has the primary CTA in focus order.
 */
function moveFocusToStep(status: string): void {
  const stepId = STEPS_BY_STATUS[status];
  if (!stepId) return;
  const stepEl = document.getElementById(stepId);
  if (!stepEl || stepEl.hidden) return;
  const heading = stepEl.querySelector<HTMLElement>('h2');
  if (!heading) return;
  // Defer to the next frame so the step's `[hidden]` removal (which
  // happens synchronously in showStepForStatus) has been committed
  // before focus moves — some browsers refuse to focus an element
  // that was still hidden in the same tick. jsdom + fake timers
  // don't run rAF on the timer mock; fall back to setTimeout(0) so
  // a future vitest test that exercises this path doesn't silently
  // miss the focus call.
  const schedule =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) =>
          window.setTimeout(() => cb(performance.now()), 0);
  schedule(() => {
    // Re-check `hidden` inside the RAF callback. If two SSE events
    // arrive in quick succession (e.g. `funded` → `failed`), the first
    // event queues a focus on step-wrapped; the second event hides
    // step-wrapped before the frame runs. Chrome quietly focuses a
    // hidden element which then re-appears invisible until the next
    // layout pass; Firefox refuses. Guard against both.
    if (stepEl.hidden) return;
    heading.focus({ preventScroll: false });
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
