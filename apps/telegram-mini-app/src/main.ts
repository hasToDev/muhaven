/**
 * MuHaven Telegram Mini App entry — mid-tier ($200–$5K) intent
 * confirmation surface.
 *
 * Flow:
 *   1. Read `?intent=oci_xxx` from window.location.
 *   2. Read `Telegram.WebApp.initData` (HMAC-signed by Telegram with
 *      the bot token; the backend re-verifies on submit).
 *   3. POST `/api/v1/agent/openclaw/intent/lookup-miniapp` with
 *      initData + intentId to get the public preview.
 *   4. User enters 6-digit OTP. The OTP was delivered out-of-band as a
 *      separate Telegram message (the bot worker sends it on intent
 *      mint).
 *   5. POST `/api/v1/agent/openclaw/intent/confirm` with initData + otp
 *      + intentId. Backend HMAC-verifies initData, matches the chat-id
 *      to a MuHaven user via telegram_links, confirms the intent.
 *   6. Show success / error / close button.
 *
 * Hardening:
 *   - initData NEVER leaves the page except in HTTPS POST bodies to the
 *     allowlisted backend origin. CSP / Referrer-Policy lock this down.
 *   - OTP is masked-by-default (centered single-line input, no echo
 *     beyond the field).
 *   - The Mini App does NOT prompt the user for a wallet signature —
 *     mid-tier intents are session-key-bound, not passkey-bound.
 *   - "Deny" path is a separate POST so an accidentally-tapped Confirm
 *     can be reverted by the user up until consume.
 *
 * Pure helpers (regex, format, fetch wrappers) live in `format.ts` +
 * `api.ts` so they can be unit-tested without a Telegram host or DOM.
 */

import { getTelegramWebApp } from './telegram.js';
import { formatUsd, isValidIntentId, isValidOtp } from './format.js';
import { createMiniAppApi, type IntentSummary } from './api.js';

const BACKEND_BASE_URL = (() => {
  // 1. Runtime override via meta tag — operator can edit a deployed
  //    `index.html` to swap backends without rebuilding (useful for
  //    a same-dist multi-tenant deploy).
  const meta = document.querySelector('meta[name="muhaven-backend"]');
  if (meta && meta.getAttribute('content')) return meta.getAttribute('content')!;
  // 2. Build-time override via Vite `--mode` env var. `bun run build:stage`
  //    in this package reads `.env.stage` and replaces `VITE_MUHAVEN_BACKEND_URL`
  //    at compile time. Values prefixed with `VITE_` are the only ones
  //    exposed to the client per Vite's security policy.
  const buildTime = (import.meta.env as Record<string, string | undefined>)
    .VITE_MUHAVEN_BACKEND_URL;
  if (buildTime && buildTime.length > 0) return buildTime;
  // 3. Default to the production homelab — Mini Apps run behind an HTTPS
  //    origin that Telegram enforces, so `http://backend:3000` isn't reachable.
  return 'https://api.muhaven.app';
})();

function $(selector: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(selector);
}

function setState(state: 'loading' | 'idle' | 'submitting' | 'done' | 'error'): void {
  const main = document.querySelector<HTMLElement>('main')!;
  main.dataset.state = state;
}

function showStatus(text: string, hideForm = true): void {
  const status = $('#status');
  const preview = $('#intent-preview');
  if (status) {
    const p = status.querySelector<HTMLElement>('.status-text');
    if (p) p.textContent = text;
    status.hidden = false;
  }
  if (hideForm && preview) preview.hidden = true;
}

function renderIntent(intent: IntentSummary): void {
  const preview = $('#intent-preview');
  if (!preview) return;
  preview.hidden = false;

  const verb = intent.kind === 'buy' ? 'Buy' : 'Claim';
  const tokenShort = `${intent.payload.token.slice(0, 6)}…${intent.payload.token.slice(-4)}`;
  preview.querySelector<HTMLElement>('.kind')!.textContent = `${verb} ${tokenShort}`;
  preview.querySelector<HTMLElement>('.issuer')!.textContent =
    intent.payload.issuerLabel ?? 'Unverified issuer';
  preview.querySelector<HTMLElement>('.amount')!.textContent = formatUsd(intent.amountUsd6);
  preview.querySelector<HTMLElement>('.hash code')!.textContent =
    `${intent.intentHash.slice(0, 10)}…${intent.intentHash.slice(-6)}`;
  preview.querySelector<HTMLElement>('.expires')!.textContent =
    new Date(intent.expiresAt).toLocaleString();
  preview.querySelector<HTMLElement>('.summary')!.textContent = intent.payload.summary;
}

async function main(): Promise<void> {
  const url = new URL(window.location.href);
  const intentId = url.searchParams.get('intent') ?? '';
  if (!isValidIntentId(intentId)) {
    showStatus('Missing or malformed intent id. Re-open the link from Telegram.');
    setState('error');
    return;
  }

  const tg = getTelegramWebApp();
  if (!tg || !tg.initData) {
    // Append a diagnostic dump under the error message so the operator
    // can see *why* initData is empty (BotFather /setdomain not set,
    // hash-eating SPA router, redirect dropped fragment, etc.).
    const debug = {
      hasWindowTelegram: typeof window.Telegram !== 'undefined',
      hasWebApp: typeof window.Telegram?.WebApp !== 'undefined',
      initDataLength: tg?.initData?.length ?? null,
      initDataUnsafeKeys: tg?.initDataUnsafe ? Object.keys(tg.initDataUnsafe) : null,
      hasUser: Boolean(tg?.initDataUnsafe?.user),
      platform: (tg as unknown as { platform?: string })?.platform ?? null,
      version: (tg as unknown as { version?: string })?.version ?? null,
      colorScheme: (tg as unknown as { colorScheme?: string })?.colorScheme ?? null,
      hasNativeBridge:
        typeof (window as unknown as { TelegramWebviewProxy?: unknown }).TelegramWebviewProxy
        !== 'undefined',
      hashLength: window.location.hash.length,
      hashFirst80: window.location.hash.slice(0, 80),
      href: window.location.href.slice(0, 200),
    };
    const message = `Open this page from Telegram so it can verify your identity.\n\n[debug]\n${JSON.stringify(debug, null, 2)}`;
    showStatus(message);
    setState('error');
    return;
  }
  tg.ready();
  tg.expand();

  const api = createMiniAppApi({ backendBaseUrl: BACKEND_BASE_URL });

  let intent: IntentSummary;
  try {
    intent = await api.lookupIntent(intentId, tg.initData);
  } catch (err) {
    showStatus(err instanceof Error ? err.message : 'Lookup failed.');
    setState('error');
    return;
  }

  renderIntent(intent);
  setState('idle');

  const form = $('#otp-form') as HTMLFormElement | null;
  const otpInput = $('#otp') as HTMLInputElement | null;
  const denyBtn = $('#deny');
  if (!form || !otpInput || !denyBtn) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const otp = otpInput.value.trim();
    if (!isValidOtp(otp)) {
      tg.HapticFeedback?.notificationOccurred?.('error');
      showStatus('Enter the 6-digit code from the @muhaven_bot message.', false);
      return;
    }
    setState('submitting');
    try {
      await api.confirmIntent(intentId, otp, tg.initData);
      tg.HapticFeedback?.notificationOccurred?.('success');
      showStatus('Confirmed. The MuHaven backend is submitting your transaction. You can close this window.');
      setState('done');
      setTimeout(() => tg.close(), 2500);
    } catch (err) {
      tg.HapticFeedback?.notificationOccurred?.('error');
      showStatus(err instanceof Error ? err.message : 'Confirm failed.', false);
      setState('idle');
    }
  });

  denyBtn.addEventListener('click', async () => {
    setState('submitting');
    try {
      await api.denyIntent(intentId, tg.initData);
      tg.HapticFeedback?.notificationOccurred?.('success');
      showStatus('Denied. Nothing was submitted on-chain. You can close this window.');
      setState('done');
      setTimeout(() => tg.close(), 2000);
    } catch (err) {
      tg.HapticFeedback?.notificationOccurred?.('error');
      showStatus(err instanceof Error ? err.message : 'Deny failed.', false);
      setState('idle');
    }
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[mini-app] fatal:', err);
  showStatus('Mini App failed to start.');
  setState('error');
});
