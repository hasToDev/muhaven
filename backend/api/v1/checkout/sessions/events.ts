import {
  CHECKOUT_SESSION_ID_RE,
} from '../../../../src/domain/checkout/model/checkout-session.js';
import { container } from '../../../../src/infrastructure/container.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withRateLimit } from '../../../../src/interface/middleware/with-rate-limit.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * GET /api/v1/checkout/sessions/events?sessionId=cs_xxx
 *
 * Server-Sent Events stream for hosted-checkout status updates. Public
 * — no auth (the URL + sessionId is the capability; status updates are
 * cleartext metadata only, not the encrypted payload).
 *
 * The buyer page opens an EventSource against this URL on load. On
 * every transition the SSE channel publishes a `data: {…}\n\n` line.
 * The page reconciles the status against its own URL fragment-decrypted
 * payload + chain state — the SSE channel is a fast-path that avoids
 * polling, NOT the source of truth.
 *
 * Connection lifecycle:
 *  - Headers + initial `retry: 5000` written immediately.
 *  - `req.on('close')` triggers subscriber cleanup.
 *  - Server-side `closeSession` ends the connection on terminal status.
 *  - Client-side, EventSource auto-reconnects after `retry` ms on
 *    network drop.
 *
 * The route bypasses `createHandler`/`createGetHandler` because those
 * close the response after the JSON body. SSE needs a long-lived
 * write-stream.
 */
const handler = async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  if (req.method !== 'GET') {
    res.status(405);
    res.setHeader('Content-Type', 'application/json');
    res.send({ error: 'Method not allowed' });
    return;
  }
  const sessionIdRaw = (req.query?.sessionId ?? '') as string;
  if (typeof sessionIdRaw !== 'string' || !CHECKOUT_SESSION_ID_RE.test(sessionIdRaw)) {
    res.status(400);
    res.setHeader('Content-Type', 'application/json');
    res.send({ error: 'invalid sessionId' });
    return;
  }
  const session = await container.checkoutSessionRepo.findById(sessionIdRaw);
  if (!session) {
    res.status(404);
    res.setHeader('Content-Type', 'application/json');
    res.send({ error: 'session not found' });
    return;
  }

  // SSE response headers. The `X-Accel-Buffering: no` is for nginx-
  // style proxies that would otherwise buffer the stream. Cloudflare
  // tunnel passes SSE through if `Cache-Control: no-cache` + `Content-
  // Type: text/event-stream` are present.
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Browsers treat the first `retry: <ms>` line as the auto-reconnect
  // window. 5s is conservative for the buyer page — the page also
  // schedules its own backoff, so this is a safety net.
  res.write('retry: 5000\n\n');

  // Snapshot the current state so the page can reconcile without a
  // separate lookup round-trip (UX: avoids race where the page sees
  // pending → settled across reloads).
  res.write(
    `event: snapshot\ndata: ${JSON.stringify({
      sessionId: session.sessionId,
      status: session.status,
      buyerAddress: session.buyerAddress,
      purchaseTxHash: session.purchaseTxHash,
      updatedAt: session.updatedAt.toISOString(),
    })}\n\n`,
  );

  // If the session is already terminal at subscribe time, write the
  // current state + close — no point holding the connection open.
  if (session.isTerminal()) {
    res.end();
    return;
  }

  const unsubscribe = container.checkoutSseChannel.subscribe(sessionIdRaw, res as unknown as import('node:http').ServerResponse);

  // Heartbeat every 25s so a connectivity-aware proxy doesn't terminate
  // the idle connection. SSE comments (lines starting with `:`) are
  // ignored by the EventSource client.
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      cleanup();
    }
  }, 25_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };

  req.on('close', cleanup);
  res.on('close', cleanup);
};

// Per-IP rate limit at 12/min — covers normal reload + occasional
// reconnect; abusive open-many-stream patterns get throttled.
export default withCors(
  withRateLimit({ maxRequests: 12, windowSeconds: 60 }, handler),
);
