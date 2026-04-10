import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { VercelHandler } from '../handler-factory.js';
import { Response } from '../response.js';
import { sendResponse } from '../handler-factory.js';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface RateLimitConfig {
  /** Max requests per window */
  maxRequests: number;
  /** Window duration in seconds */
  windowSeconds: number;
  /** Key extractor — defaults to IP address */
  keyFn?: (req: VercelRequest) => string;
}

// In-memory fixed-window store — keyed by (route identifier + client IP)
// Each withRateLimit() call gets its own store so different routes have independent counters.

// Periodic cleanup to prevent memory leaks (runs at most once per minute)
let lastCleanup = Date.now();
function cleanupStale(store: Map<string, RateLimitEntry>): void {
  const now = Date.now();
  if (now - lastCleanup < 60_000) return;
  lastCleanup = now;
  for (const [key, entry] of store) {
    if (entry.resetAt < now) store.delete(key);
  }
}

function getClientIp(req: VercelRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

/**
 * Simple in-memory rate limiter using fixed windows.
 * Each call creates an independent store — different routes don't share counters.
 *
 * Usage:
 *   export default withCors(withRateLimit({ maxRequests: 10, windowSeconds: 60 }, handler));
 */
export function withRateLimit(config: RateLimitConfig, handler: VercelHandler): VercelHandler {
  const { maxRequests, windowSeconds, keyFn } = config;
  // Per-route store — created once per withRateLimit() call
  const store = new Map<string, RateLimitEntry>();

  return async (req: VercelRequest, res: VercelResponse): Promise<void> => {
    cleanupStale(store);

    const clientKey = keyFn ? keyFn(req) : getClientIp(req);
    const now = Date.now();
    const windowMs = windowSeconds * 1000;

    let entry = store.get(clientKey);
    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(clientKey, entry);
    }

    entry.count++;

    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      sendResponse(res, Response.tooManyRequests('Rate limit exceeded', retryAfter, `Try again in ${retryAfter}s`));
      return;
    }

    return handler(req, res);
  };
}
