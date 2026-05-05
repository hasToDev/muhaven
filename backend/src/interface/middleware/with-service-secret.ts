import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendResponse, type VercelHandler } from '../handler-factory.js';
import { Response } from '../response.js';

/**
 * Service-to-service shared-secret middleware (Wave 4 P4).
 *
 * Used by the Telegram bot worker → backend handoff: the worker holds a
 * `TELEGRAM_BOT_SERVICE_SECRET` and presents it as
 * `Authorization: Bearer <secret>`. The backend rejects any caller
 * without the matching secret. Constant-time string compare to defeat
 * timing oracles.
 *
 * Intentionally NOT used for user-driven flows — those go through the
 * standard SIWE/JWT `withAuth`. Service secrets bypass user auth
 * entirely; routes that need both must compose `withServiceSecret` for
 * the worker call AND embed the userId in the request body (which the
 * use case validates against domain ownership rules).
 *
 * The middleware is also a defence against accidentally exposing the
 * intent-mint endpoint to the open internet — without the secret in the
 * env, the route returns 503 service-unavailable rather than silently
 * accepting unauthenticated requests.
 */
export interface WithServiceSecretOptions {
  /** Env-var name to read the expected secret from. */
  envVar: string;
  /** Display name for logs / error messages. */
  serviceName: string;
}

export function withServiceSecret(
  opts: WithServiceSecretOptions,
  handler: VercelHandler,
): VercelHandler {
  return async (req: VercelRequest, res: VercelResponse): Promise<void> => {
    const expected = process.env[opts.envVar];
    if (!expected || expected.length < 16) {
      sendResponse(
        res,
        {
          statusCode: 503,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'about:blank',
            title: 'Service Unavailable',
            status: 503,
            detail: `${opts.serviceName} integration disabled — ${opts.envVar} is not configured`,
          }),
        },
      );
      return;
    }

    const header = req.headers.authorization;
    const supplied = typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice(7).trim()
      : '';

    if (!supplied || supplied.length !== expected.length || !constantTimeEqual(supplied, expected)) {
      sendResponse(res, Response.unauthorized('Unauthorized'));
      return;
    }

    return handler(req, res);
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
