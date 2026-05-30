/**
 * GET /v1/issuer/tokens/deploy/:id/events
 *
 * Phase 9.A · Expansion (F2) — SSE stream for a token deploy job. The
 * client connects via `EventSource('…/events')` and receives a feed of
 * `step` events as the deploy progresses, terminating with a
 * `finalize` event carrying the result token address (or error).
 *
 * Auth: bearer token in the URL query (`?access_token=…`) since
 * EventSource doesn't support `Authorization` headers. Same JWT secret
 * + issuer as the standard `withAuth` middleware. Role-checked to
 * `issuer`. The deploy row is checked for ownership so a user can only
 * stream their own deploys.
 *
 * The handler bypasses `createGetHandler` because SSE needs raw access
 * to the underlying response stream.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { jwtVerify } from 'jose';
import { getEnv } from '../../../../../../src/core/config.js';
import { container } from '../../../../../../src/infrastructure/container.js';
import { deployEventBus, type DeployEvent } from '../../../../../../src/infrastructure/onboarding/deploy-event-bus.js';

// `VercelResponse` already extends Node's `ServerResponse`, so `write`,
// `end`, and `flushHeaders` are all present — no narrowing wrapper needed
// (a previous `RawResponse extends VercelResponse` re-declaration clashed
// with @vercel/node v5's stricter overload set).
async function authenticate(
  req: VercelRequest,
): Promise<{ userId: string; role: string } | null> {
  // EventSource ships only headers it can't override — read access_token
  // from the URL query first, fall back to Authorization header so curl
  // / Postman / proxied tests still work.
  const tokenFromQuery =
    typeof req.query.access_token === 'string' ? req.query.access_token : null;
  const headerAuth = req.headers.authorization;
  const tokenFromHeader =
    headerAuth && headerAuth.startsWith('Bearer ') ? headerAuth.slice(7) : null;
  const token = tokenFromQuery ?? tokenFromHeader;
  if (!token) return null;

  try {
    const { JWT_SECRET, JWT_ISSUER } = getEnv();
    const secret = new TextEncoder().encode(JWT_SECRET);
    const { payload } = await jwtVerify(token, secret, { issuer: JWT_ISSUER });
    return {
      userId: payload.sub as string,
      role: payload.role as string,
    };
  } catch {
    return null;
  }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  // CORS preflight + auth happen here directly so we control the
  // header-set for SSE. The default `withCors` would also work but
  // setting them inline is clearer for streaming.
  const env = getEnv();
  const origin = req.headers.origin;
  if (origin && env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const auth = await authenticate(req);
  if (!auth) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (auth.role !== 'issuer') {
    res.status(403).json({ error: 'issuer role required' });
    return;
  }

  const deployId = req.query.id as string;
  if (!deployId || !/^[0-9a-fA-F-]{36}$/.test(deployId)) {
    res.status(400).json({ error: 'Invalid deploy id' });
    return;
  }

  const deploy = await container.issuerTokenDeployRepo.findById(deployId);
  if (!deploy) {
    res.status(404).json({ error: 'Deploy not found' });
    return;
  }
  if (deploy.userId !== auth.userId) {
    res.status(403).json({ error: 'Cannot stream another user\'s deploy' });
    return;
  }

  const raw = res;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Disable proxy buffering (nginx / cloudflare) so events flush
  // immediately. `X-Accel-Buffering` is the canonical header.
  res.setHeader('X-Accel-Buffering', 'no');
  raw.flushHeaders?.();

  const writeEvent = (eventName: string, data: unknown): void => {
    raw.write(`event: ${eventName}\n`);
    raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // If the deploy is already terminal, emit the synthesised finalize
  // event from the persisted row + close. The bus's recent-buffer
  // window may have aged out by the time a late client connects.
  if (deploy.status !== 'running') {
    writeEvent('finalize', {
      step: 'finalize',
      status: deploy.status,
      resultTokenAddress: deploy.resultTokenAddress ?? undefined,
      errorMessage: deploy.errorMessage ?? undefined,
      ts: (deploy.completedAt ?? deploy.createdAt).toISOString(),
    });
    raw.end();
    return;
  }

  // Subscribe + heartbeat. SSE best practice: emit a comment ping every
  // ~25s so proxies don't kill the connection during quiet windows.
  const handleEvent = (event: DeployEvent) => {
    const eventName = event.step === 'finalize' ? 'finalize' : 'step';
    writeEvent(eventName, event);
    if (event.step === 'finalize') {
      // Flush + close shortly so the client knows the stream is done.
      // Don't end immediately — give the proxy a moment to forward.
      setTimeout(() => raw.end(), 100);
    }
  };
  const unsubscribe = deployEventBus.subscribe(deployId, handleEvent);

  const heartbeat = setInterval(() => {
    raw.write(`: keepalive ${Date.now()}\n\n`);
  }, 25_000);

  // Cleanup on socket close from either side.
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
  res.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}
