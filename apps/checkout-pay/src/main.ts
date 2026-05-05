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

import { CheckoutBackend, type CheckoutSessionDto } from './backend.js';
import { decryptPayload, formatUsd6, type CheckoutPayload } from './decrypt.js';
import { parseCheckoutLocation } from './fragment.js';
import {
  FaucetRedirectProvider,
  type FundingProvider,
} from './funding-provider.js';

interface PageState {
  session: CheckoutSessionDto;
  payload: CheckoutPayload;
  buyerAddress: string | null;
}

const backend = new CheckoutBackend();
const fundingProvider: FundingProvider = new FaucetRedirectProvider();

bootstrap().catch((err) => {
  console.error('checkout bootstrap failed', err);
  showError(err instanceof Error ? err.message : 'Unknown error');
});

async function bootstrap(): Promise<void> {
  showSection('loading');

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
  // Wave 4 placeholder — real ZeroDev SDK integration lands in Wave 5.
  // The shape stays stable: provision kernel, surface address, set
  // `state.buyerAddress`, transition to `funded` once chain reports
  // `≥ amount` USDC.
  //
  // For the hackathon demo the page asks the buyer for an address (or
  // generates a deterministic placeholder bound to the sessionId). The
  // real ceremony will swap the prompt for `passkeyKernelClient.create`
  // + return the kernel address.
  const provisional = state.buyerAddress ?? prompt(
    'Wave 4 demo placeholder — paste your kernel address to continue. Wave 5 will replace this with the ZeroDev passkey ceremony.',
  );
  if (!provisional) return;
  if (!/^0x[a-fA-F0-9]{40}$/.test(provisional)) {
    showError('Address must be a 0x-prefixed 40-char hex string.');
    return;
  }
  state.buyerAddress = provisional;
  showFundingStep(state);
}

function showFundingStep(state: PageState): void {
  if (!state.buyerAddress) return;
  const stepFunding = document.getElementById('step-funding');
  if (!stepFunding) return;
  // Mount the funding provider under the existing CTA block.
  const slot = stepFunding.querySelector('#kernel-address');
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
