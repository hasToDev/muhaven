/**
 * Pure API surface for the Mini App backend calls.
 *
 * Extracted from `main.ts` so request/response shapes + error
 * translation can be unit-tested with a fetch stub. `main.ts` consumes
 * these via dependency injection (`createMiniAppApi(globalThis.fetch)`).
 */

export interface IntentSummary {
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

export interface MiniAppApi {
  lookupIntent(intentId: string, initData: string): Promise<IntentSummary>;
  confirmIntent(intentId: string, otp: string, initData: string): Promise<void>;
  denyIntent(intentId: string, initData: string): Promise<void>;
}

export interface MiniAppApiOpts {
  /** Backend base URL (no trailing slash). */
  backendBaseUrl: string;
  /** Injectable fetch — defaults to global. Tests inject a stub. */
  fetchImpl?: typeof fetch;
}

export function createMiniAppApi(opts: MiniAppApiOpts): MiniAppApi {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const base = opts.backendBaseUrl.replace(/\/$/, '');

  async function lookupIntent(intentId: string, initData: string): Promise<IntentSummary> {
    const res = await fetchImpl(`${base}/api/v1/agent/openclaw/intent/lookup-miniapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intentId, telegramInitData: initData }),
    });
    if (!res.ok) {
      const reason =
        res.status === 404
          ? 'Intent not found or no longer active.'
          : `Lookup failed (HTTP ${res.status}).`;
      throw new Error(reason);
    }
    return (await res.json()) as IntentSummary;
  }

  async function confirmIntent(
    intentId: string,
    otp: string,
    initData: string,
  ): Promise<void> {
    const res = await fetchImpl(`${base}/api/v1/agent/openclaw/intent/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intentId, otp, telegramInitData: initData, source: 'mini_app' }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({ title: 'Unknown error' }))) as {
        title?: string;
      };
      throw new Error(body.title ?? `Confirm failed (HTTP ${res.status}).`);
    }
  }

  async function denyIntent(intentId: string, initData: string): Promise<void> {
    const res = await fetchImpl(`${base}/api/v1/agent/openclaw/intent/deny`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intentId, telegramInitData: initData, source: 'mini_app' }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({ title: 'Unknown error' }))) as {
        title?: string;
      };
      throw new Error(body.title ?? `Deny failed (HTTP ${res.status}).`);
    }
  }

  return { lookupIntent, confirmIntent, denyIntent };
}
