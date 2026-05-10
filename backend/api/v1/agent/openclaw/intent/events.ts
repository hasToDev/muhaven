import { container } from '../../../../../src/infrastructure/container.js';
import { withCors } from '../../../../../src/interface/middleware/with-cors.js';
import { withRateLimit } from '../../../../../src/interface/middleware/with-rate-limit.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * GET /api/v1/agent/openclaw/intent/events?access_token=<jwt>
 *
 * Wave 4 P4 — Server-Sent Events stream for OpenClaw intent state
 * changes scoped to the authenticated user. The dashboard `/agent` route
 * opens an EventSource here on mount; when the user taps Confirm in
 * Telegram, the bot worker → backend → channel → here fans the
 * `intent_confirmed` event so the dashboard runner auto-fires the
 * on-chain leg without the operator coming back and re-clicking
 * Authorize.
 *
 * Auth via `?access_token=<jwt>` query string (mirrors the existing
 * `/api/v1/issuer/tokens/deploy/<id>/events` SSE route's convention)
 * — EventSource (the browser primitive) cannot set custom headers,
 * so the token rides along in the URL. The JWT is short-lived
 * (`ACCESS_TOKEN_TTL`); a stolen URL is bounded by that TTL + the SSE
 * channel's per-user fan-out (the listener only sees events for their
 * own userId).
 *
 * Connection lifecycle:
 *  - Headers + initial `retry: 5000` written immediately.
 *  - `req.on('close')` triggers subscriber cleanup.
 *  - 25s heartbeat keeps the connection alive through Cloudflare /
 *    nginx-style proxies.
 *
 * The route bypasses `createHandler` because that closes the response
 * after the JSON body. SSE needs a long-lived write-stream.
 *
 * Privacy posture (publish side): the SSE channel publishes the
 * cleartext intent preview the user already saw at propose time —
 * NEVER the OTP, NEVER the confirm-token, NEVER an encrypted handle.
 */

const handler = async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  if (req.method !== 'GET') {
    res.status(405);
    res.setHeader('Content-Type', 'application/json');
    res.send({ error: 'Method not allowed' });
    return;
  }
  // Query-string JWT auth. EventSource cannot set Authorization headers,
  // so the token rides along in the URL. Note: the URL ends up in the
  // browser's history + any access logs that capture query strings —
  // bounded by the JWT's short TTL (default 1h) and the per-user
  // fan-out scope of the channel itself (a stolen URL only lets the
  // attacker observe the victim's own intent state changes, NOT confirm
  // anything; confirm goes through the separate /confirm-inline path).
  // Param name mirrors the existing issuer-onboarding SSE route's
  // `access_token` convention so the SPA pattern stays uniform.
  const tokenRaw = (req.query?.access_token ?? '') as string;
  if (typeof tokenRaw !== 'string' || tokenRaw.length === 0) {
    res.status(401);
    res.setHeader('Content-Type', 'application/json');
    res.send({ error: 'access_token query param required' });
    return;
  }
  let userId: string;
  try {
    const claims = await container.jwtService.verifyAccessToken(tokenRaw);
    userId = claims.sub;
  } catch {
    res.status(401);
    res.setHeader('Content-Type', 'application/json');
    res.send({ error: 'invalid or expired token' });
    return;
  }
  if (!userId || userId.length === 0) {
    res.status(401);
    res.setHeader('Content-Type', 'application/json');
    res.send({ error: 'token missing subject' });
    return;
  }

  // SSE response headers. `X-Accel-Buffering: no` defeats nginx-style
  // proxy buffering. Cloudflare tunnel passes SSE through cleanly when
  // `Cache-Control: no-cache` + `Content-Type: text/event-stream`.
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Browsers honour the first `retry: <ms>` line for auto-reconnect.
  // 5s mirrors the checkout SSE — conservative + matches what the
  // dashboard's auto-reconnect-on-drop logic expects.
  res.write('retry: 5000\n\n');
  // Open-stream sentinel so the client knows the channel is wired
  // (vs. the connection being held by an inert proxy).
  res.write(
    `event: open\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`,
  );

  const unsubscribe = container.openClawIntentEventsChannel.subscribe(
    userId,
    res as unknown as import('node:http').ServerResponse,
  );

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

// Per-IP rate limit at 12/min — same posture as the checkout SSE route
// (covers normal reload + reconnect bursts; abusive open-many-stream
// patterns throttle).
export default withCors(
  withRateLimit({ maxRequests: 12, windowSeconds: 60 }, handler),
);
