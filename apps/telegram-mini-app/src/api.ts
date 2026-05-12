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
    // `source` is intentionally omitted: the backend's confirm DTO is
    // `.strict()` and rejects extra fields with 422 "Validation failed".
    // The audit-trail source ('mini_app' here) is server-derived from
    // the auth path (H-1 hardening in confirm.ts) — sending it from the
    // client would be ignored at best and rejected at worst.
    const res = await fetchImpl(`${base}/api/v1/agent/openclaw/intent/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intentId, otp, telegramInitData: initData }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({ title: 'Unknown error' }))) as {
        title?: string;
      };
      throw new Error(body.title ?? `Confirm failed (HTTP ${res.status}).`);
    }
  }

  async function denyIntent(intentId: string, initData: string): Promise<void> {
    // Same H-1 hardening as confirmIntent — `source` is server-derived,
    // not client-provided. Backend deny DTO is `.strict()` and would
    // reject the extra field.
    const res = await fetchImpl(`${base}/api/v1/agent/openclaw/intent/deny`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intentId, telegramInitData: initData }),
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
