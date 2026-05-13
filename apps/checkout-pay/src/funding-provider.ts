/**
 * Pluggable funding-provider abstraction (Wave 4 P5 + forward-port to
 * Wave 5).
 *
 * The buyer page needs a way to bring USDC to the buyer's kernel
 * address. Wave 4 ships `FaucetRedirectProvider` (Circle testnet
 * faucet); Wave 5 swaps for `SardineProvider` / `CoinbaseOnrampProvider`
 * / `MoonPayProvider`. By keeping the contract narrow + the swap
 * mechanical, this is the kind of upgrade that doesn't touch the rest
 * of the page.
 *
 * Locked decision (PROGRESS.md §"Phase P5"): testnet funding strategy
 * = Option A (faucet redirect). Option B (admin-funded faucet pool)
 * EXPLICITLY REJECTED — too far from production code path.
 *
 * Production trajectory: this file is the swap point.
 */

import type { CheckoutPayload } from './decrypt.js';

export interface FundingContext {
  buyerAddress: string;
  payload: CheckoutPayload;
  /** Issuer label resolved at session-create time (verified or otherwise). */
  issuerLabel: string | null;
}

export interface FundingProviderRender {
  /** DocumentFragment to mount into the funding step container. */
  fragment: DocumentFragment;
  /** Optional callback the page invokes once the provider believes the
   *  funding action has completed. The page reconciles by polling the
   *  buyer's kernel balance + flipping to `funded` if backed. */
  onCompleted?: () => void;
}

export interface FundingProvider {
  /** Short string for telemetry / audit-log. */
  readonly id: string;
  render(ctx: FundingContext): FundingProviderRender;
}

/**
 * Wave 4 provider — opens the Circle testnet faucet in a new tab and
 * shows the buyer's wallet address with a copy button.
 *
 * The page side-runs a wallet-balance poll loop; this provider is
 * "hands-off" once rendered.
 */
export class FaucetRedirectProvider implements FundingProvider {
  readonly id = 'faucet_redirect';

  render(ctx: FundingContext): FundingProviderRender {
    const tpl = document.createElement('template');
    // Wave 5 buyer-side port (P2): the `[data-funding-poll-status]`
    // element is wired by `main.ts:ensureFundingPollerStarted` — every
    // 5 s tick of the FundingPoller updates the text + `data-poll-state`
    // attribute. Pre-poll text reads "Checking balance…" so the user
    // sees a live affordance instead of dead "we'll continue
    // automatically" copy. The first tick is synchronous on `start()`
    // so the placeholder text rarely survives more than a few frames.
    //
    // NOTE on screen-reader announcements: the visible element below
    // is intentionally NOT a live region (no `aria-live`). Announcing
    // the rotating "Current balance: X.XX — waiting for ≥ Y.YY" copy
    // every 5 s spams NVDA / JAWS / VoiceOver users (the WCAG 4.1.3
    // Status Messages anti-pattern). Instead, `main.ts` writes
    // STATE-TRANSITION announcements (waiting → funded → error) to
    // the `[data-funding-poll-announce]` / `[data-funding-poll-alert]`
    // sr-only regions in `index.html` so each transition is spoken
    // exactly once.
    tpl.innerHTML = `
      <div class="funding-faucet">
        <p>
          Circle's faucet drops <strong>10 testnet USDC</strong> per
          request. Drop two if you need to top up over $10.
        </p>
        <code class="address" data-faucet-address></code>
        <div class="cta-row">
          <button class="cta-secondary" data-faucet-copy type="button">Copy address</button>
          <a class="cta" data-faucet-link href="https://faucet.circle.com/" target="_blank" rel="noopener noreferrer">Open Circle faucet</a>
        </div>
        <p class="hint">
          We're watching your balance every few seconds. As soon as it
          hits <strong>${formatHintAmount(ctx.payload.amountUsd6)} USDC</strong>
          we'll move you on to the purchase step automatically.
        </p>
        <p class="poll-status" data-funding-poll-status data-poll-state="waiting">
          Checking balance…
        </p>
      </div>
    `;
    const fragment = tpl.content;
    const addr = fragment.querySelector<HTMLElement>('[data-faucet-address]');
    const copyBtn = fragment.querySelector<HTMLButtonElement>('[data-faucet-copy]');
    if (addr) addr.textContent = ctx.buyerAddress;
    if (copyBtn) {
      let revertTimer: ReturnType<typeof setTimeout> | null = null;
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(ctx.buyerAddress);
          copyBtn.textContent = 'Copied';
          if (revertTimer !== null) clearTimeout(revertTimer);
          revertTimer = setTimeout(() => {
            // Skip the revert if the button has been detached from the
            // DOM (e.g. a Wave 5 P2 idempotent re-render replaced the
            // funding slot). Without this, the closure pins the
            // detached subtree until the timer fires — bounded but
            // observable in jsdom timer-count assertions.
            if (copyBtn.isConnected) {
              copyBtn.textContent = 'Copy address';
            }
            revertTimer = null;
          }, 1500);
        } catch {
          copyBtn.textContent = 'Copy failed — select manually';
        }
      });
    }
    return { fragment };
  }
}

/**
 * Stub that other providers (Wave 5 fiat on-ramps) can extend. Kept
 * here — not separately exported — so Wave 5 PR is a single-file change.
 */
export abstract class OnrampProviderBase implements FundingProvider {
  abstract readonly id: string;
  abstract render(ctx: FundingContext): FundingProviderRender;
}

function formatHintAmount(amountUsd6: string): string {
  const padded = amountUsd6.padStart(7, '0');
  const intPart = padded.slice(0, padded.length - 6).replace(/^0+(\d)/, '$1');
  const fracPart = padded.slice(-6).replace(/0+$/, '');
  if (!fracPart) return intPart;
  return `${intPart}.${fracPart}`;
}
