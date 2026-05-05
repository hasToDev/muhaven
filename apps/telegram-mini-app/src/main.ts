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
 */

import { getTelegramWebApp } from './telegram.js';

interface IntentSummary {
  intentId: string;
  kind: 'buy' | 'claim';
  tier: 'inline' | 'mini_app_otp' | 'passkey_deeplink';
  status: 'pending' | 'confirmed' | 'consumed' | 'denied' | 'expired';
  amountUsd6: string;
  payload: { token: string; summary: string; issuerLabel?: string; escrowId?: string };
  intentHash: string;
  expiresAt: string;
  createdAt: string;
}

const BACKEND_BASE_URL = (() => {
  // Allow override via meta tag for staging swaps.
  const meta = document.querySelector('meta[name="muhaven-backend"]');
  if (meta && meta.getAttribute('content')) return meta.getAttribute('content')!;
  // Default to the production homelab — Mini Apps run behind an HTTPS
  // origin that Telegram enforces, so http://backend:3000 isn't reachable.
  return 'https://nagreg.hasto.dev';
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

function formatUsd(amountUsd6: string): string {
  const parsed = BigInt(amountUsd6);
  const whole = parsed / 1_000_000n;
  const cents = parsed % 1_000_000n;
  const wholeStr = whole.toString();
  // Show 2-decimal display for amounts under 1M USD, drop the cents
  // for larger values.
  if (whole < 1_000_000n) {
    const centsTwo = (cents / 10_000n).toString().padStart(2, '0');
    return `$${withSeparators(wholeStr)}.${centsTwo}`;
  }
  return `$${withSeparators(wholeStr)}`;
}

function withSeparators(intStr: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

async function lookupIntent(intentId: string, initData: string): Promise<IntentSummary> {
  const res = await fetch(`${BACKEND_BASE_URL}/api/v1/agent/openclaw/intent/lookup-miniapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intentId, telegramInitData: initData }),
  });
  if (!res.ok) {
    const reason = res.status === 404 ? 'Intent not found or no longer active.' : `Lookup failed (HTTP ${res.status}).`;
    throw new Error(reason);
  }
  return (await res.json()) as IntentSummary;
}

async function confirmIntent(intentId: string, otp: string, initData: string): Promise<void> {
  const res = await fetch(`${BACKEND_BASE_URL}/api/v1/agent/openclaw/intent/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intentId, otp, telegramInitData: initData, source: 'mini_app' }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ title: 'Unknown error' }));
    throw new Error(body.title || `Confirm failed (HTTP ${res.status}).`);
  }
}

async function denyIntent(intentId: string, initData: string): Promise<void> {
  const res = await fetch(`${BACKEND_BASE_URL}/api/v1/agent/openclaw/intent/deny`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intentId, telegramInitData: initData, source: 'mini_app' }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ title: 'Unknown error' }));
    throw new Error(body.title || `Deny failed (HTTP ${res.status}).`);
  }
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
  if (!/^oci_[A-Z0-9]{26}$/.test(intentId)) {
    showStatus('Missing or malformed intent id. Re-open the link from Telegram.');
    setState('error');
    return;
  }

  const tg = getTelegramWebApp();
  if (!tg || !tg.initData) {
    showStatus('Open this page from Telegram so it can verify your identity.');
    setState('error');
    return;
  }
  tg.ready();
  tg.expand();

  // Render the dashboard origin so the user can see at a glance which
  // backend they are talking to.
  const originLabel = $('.origin');
  if (originLabel) originLabel.textContent = new URL(BACKEND_BASE_URL).host;

  let intent: IntentSummary;
  try {
    intent = await lookupIntent(intentId, tg.initData);
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
    if (!/^\d{6}$/.test(otp)) {
      tg.HapticFeedback?.notificationOccurred?.('error');
      showStatus('Enter the 6-digit code from the @muhaven_bot message.', false);
      return;
    }
    setState('submitting');
    try {
      await confirmIntent(intentId, otp, tg.initData);
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
      await denyIntent(intentId, tg.initData);
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
