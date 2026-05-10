import type { ServerResponse } from 'node:http';

/**
 * In-process SSE fan-out for OpenClaw intent state changes (Wave 4 P4).
 *
 * Wires the missing piece for the §4 Telegram-confirm-back-to-dashboard
 * UX: when a user taps Confirm in Telegram, the bot calls the backend's
 * `/intent/confirm-inline` (or the Mini App calls `/intent/confirm`),
 * the use-case marks the intent confirmed in DB, and ALSO publishes
 * here. Any open dashboard tab with an SSE subscription on `/agent` for
 * this user receives the event and the runner auto-fires the on-chain
 * leg without the user having to come back and click Authorize.
 *
 * Design parallels `infrastructure/checkout/sse-channel.ts` (Wave 4 P5)
 * but keys subscribers on `userId` (not `sessionId`) — the dashboard
 * tab is JWT-authenticated to the user, not to a single intent.
 *
 * Single-process MVP. Multi-replica deploys (Wave 5) need Redis pub/sub
 * — same trade-off documented for the checkout SSE channel.
 *
 * Privacy posture: the published event carries the cleartext intent
 * preview that the user already saw the LLM emit at propose time
 * (intentId, kind, tier, payload). NEVER the OTP, NEVER an encrypted
 * handle, NEVER a confirm-token (R-3 boundary — same as the
 * `stripPrivilegedActionFields` enforced for the LLM round-trip path).
 */

export type OpenClawIntentEventType =
  | 'intent_confirmed'
  | 'intent_consumed'
  | 'intent_denied';

export interface OpenClawIntentEvent {
  type: OpenClawIntentEventType;
  /** MuHaven user-id this event is scoped to. */
  userId: string;
  /** Intent identifier — `oci_<26-char Crockford-base32>`. */
  intentId: string;
  /** Cleartext intent shape — what the user already saw the LLM emit. */
  payload: {
    kind: 'buy' | 'claim';
    tier: 'inline' | 'mini_app_otp' | 'passkey_deeplink';
    /** Source surface that drove the confirm (`telegram_inline` / `mini_app` /
     *  `dashboard_passkey`) — informative for the dashboard runner so it
     *  can surface "Confirmed via Telegram" toast vs. silent auto-fire. */
    source?: 'telegram_inline' | 'mini_app' | 'dashboard_passkey';
    /** Token address the intent operates on. */
    tokenAddress: string;
    /** USDC 6-decimal amount serialised as decimal string. */
    amountUsd6: string;
  };
}

interface Subscriber {
  userId: string;
  res: ServerResponse;
}

export class OpenClawIntentEventsChannel {
  private subscribers = new Set<Subscriber>();

  /**
   * Register a subscriber. Caller writes the SSE response headers + the
   * initial `retry` line BEFORE invoking this — keeps the channel
   * service unit-testable without a full ServerResponse mock surface.
   * Returns an unsubscribe function the route handler invokes on
   * `req.on('close')`.
   */
  subscribe(userId: string, res: ServerResponse): () => void {
    const sub: Subscriber = { userId, res };
    this.subscribers.add(sub);
    return () => {
      this.subscribers.delete(sub);
    };
  }

  /**
   * Publish an event to every subscriber of the given user. Best-effort:
   * write failures (aborted client) sweep the subscriber. Returns the
   * number of subscribers the event was successfully written to.
   */
  publish(event: OpenClawIntentEvent): number {
    let n = 0;
    for (const sub of this.subscribers) {
      if (sub.userId !== event.userId) continue;
      try {
        sub.res.write(formatSseFrame(event));
        n++;
      } catch {
        this.subscribers.delete(sub);
      }
    }
    return n;
  }

  /** Test helper. */
  subscriberCount(userId?: string): number {
    if (userId === undefined) return this.subscribers.size;
    let n = 0;
    for (const sub of this.subscribers) {
      if (sub.userId === userId) n++;
    }
    return n;
  }
}

/**
 * Format an SSE frame. Exposed for unit testing the encoder; production
 * consumers go through `publish`.
 */
export function formatSseFrame(event: OpenClawIntentEvent): string {
  const payload = JSON.stringify({
    type: event.type,
    intentId: event.intentId,
    payload: event.payload,
  });
  return `event: ${event.type}\ndata: ${payload}\n\n`;
}
