import type { ServerResponse } from 'node:http';

/**
 * In-process SSE fan-out for hosted-checkout status updates (Wave 4 P5).
 *
 * The hosted page subscribes to `/api/v1/checkout/sessions/[sessionId]/events`
 * and receives a `data: {...}\n\n` line for every state transition. The
 * dispatcher writes here at the same time it persists the row, so a
 * settled session pushes a `settled` event to any active client.
 *
 * Design notes:
 *  - Single-process / single-replica. With the homelab Docker stack
 *    running one backend container, this is fine. Multi-replica deploys
 *    (Wave 5) need Redis pub/sub or a managed broker — flagged in
 *    DEV_LOG.
 *  - Subscribers identify by `sessionId`. Many subscribers per session
 *    are allowed (e.g., issuer dashboard tab + buyer page + ops view).
 *  - On disconnect (`req.on('close')`), the subscriber is removed; we
 *    DO NOT track liveness with explicit pings — the page is short-lived
 *    (≤30 min TTL) and the client side schedules its own reconnect.
 *  - SSE retry backoff is announced via the standard `retry: <ms>` line
 *    on initial connect.
 *
 * Why not a generic WebSocket abstraction? Two reasons: (a) SSE works
 * through every CDN / Cloudflare tunnel without WebSocket upgrade
 * support, (b) the surface is one-way server-to-client, so a generic
 * pub/sub adds avoidable complexity.
 */

export interface CheckoutEvent {
  type: string;
  sessionId: string;
  /** Cleartext metadata only — never the encrypted payload. */
  data: Record<string, unknown>;
}

interface Subscriber {
  sessionId: string;
  res: ServerResponse;
}

export class SseChannelService {
  private subscribers = new Set<Subscriber>();

  /**
   * Register a subscriber. Caller is responsible for setting the SSE
   * response headers + writing the initial `retry` line BEFORE calling
   * here — keeps the channel service unit-testable without a full
   * `http.ServerResponse` mock surface.
   */
  subscribe(sessionId: string, res: ServerResponse): () => void {
    const sub: Subscriber = { sessionId, res };
    this.subscribers.add(sub);
    return () => {
      this.subscribers.delete(sub);
    };
  }

  /**
   * Publish an event to every subscriber of the given session. Best
   * effort — write failures (e.g., aborted client) are silently swept
   * by removing the subscriber. Returns the number of subscribers the
   * event was successfully written to.
   */
  publish(event: CheckoutEvent): number {
    let n = 0;
    for (const sub of this.subscribers) {
      if (sub.sessionId !== event.sessionId) continue;
      try {
        sub.res.write(formatSseFrame(event));
        n++;
      } catch {
        this.subscribers.delete(sub);
      }
    }
    return n;
  }

  /**
   * Close every active subscriber for `sessionId`. Used on terminal
   * transitions (`settled` / `expired` / `failed`) so the client tears
   * down the EventSource without an extra round-trip.
   */
  closeSession(sessionId: string): number {
    let n = 0;
    for (const sub of this.subscribers) {
      if (sub.sessionId !== sessionId) continue;
      try {
        sub.res.end();
      } catch {
        // ignore
      }
      this.subscribers.delete(sub);
      n++;
    }
    return n;
  }

  /** Test helper. */
  subscriberCount(sessionId?: string): number {
    if (sessionId === undefined) return this.subscribers.size;
    let n = 0;
    for (const sub of this.subscribers) {
      if (sub.sessionId === sessionId) n++;
    }
    return n;
  }
}

/**
 * Format an SSE frame. Exposed for unit testing the encoder; production
 * consumers go through `publish`.
 */
export function formatSseFrame(event: CheckoutEvent): string {
  const payload = JSON.stringify({
    type: event.type,
    sessionId: event.sessionId,
    data: event.data,
  });
  // Single-line escape — JSON.stringify already escapes `\n` inside the
  // payload, so a one-line `data:` is safe and parses on every standard
  // EventSource client.
  return `event: ${event.type}\ndata: ${payload}\n\n`;
}
