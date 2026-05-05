import type { VercelRequest, VercelResponse } from '@vercel/node';
import { jwtVerify } from 'jose';
import { getEnv } from '../../core/config.js';
import type { AuthPayload } from '../auth/auth-payload.js';
import type { AuthenticatedRequest, VercelHandler } from '../handler-factory.js';
import { Response, type HttpResponse } from '../response.js';
import { sendResponse } from '../handler-factory.js';

function extractBearerToken(req: VercelRequest): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }
  return header.slice(7);
}

export function withAuth(handler: VercelHandler): VercelHandler {
  return async (req: VercelRequest, res: VercelResponse): Promise<void> => {
    const token = extractBearerToken(req);

    if (!token) {
      sendResponse(res, Response.unauthorized('Missing authorization', 'Bearer token is required'));
      return;
    }

    try {
      const { JWT_SECRET, JWT_ISSUER } = getEnv();
      const secret = new TextEncoder().encode(JWT_SECRET);

      const { payload } = await jwtVerify(token, secret, {
        issuer: JWT_ISSUER,
      });

      const ap: AuthPayload = {
        ...(payload as object),
        userId: payload.sub as string,
      } as unknown as AuthPayload;
      // jwtVerify returns scope as unknown[] when present — narrow to string[].
      const rawScope = (payload as { scope?: unknown }).scope;
      if (Array.isArray(rawScope)) {
        ap.scope = rawScope.filter((s): s is string => typeof s === 'string');
      }
      (req as AuthenticatedRequest).authPayload = ap;
    } catch {
      sendResponse(res, Response.unauthorized('Invalid token', 'Token verification failed'));
      return;
    }

    return handler(req, res);
  };
}
