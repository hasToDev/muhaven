import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { AuthenticatedRequest, VercelHandler } from '../handler-factory.js';
import { sendResponse } from '../handler-factory.js';
import { Response } from '../response.js';

/**
 * Scope-gating middleware (Wave 4 P3 ADR-3 D2).
 *
 * Wrap a route's downstream handler with one or more required scope
 * patterns. Tokens that lack a `scope` claim entirely are treated as
 * UNSCOPED — i.e., they have ALL scopes — for backwards compatibility
 * with the dashboard's existing SIWE access tokens, which predate this
 * middleware. Device-flow tokens always carry an explicit scope claim.
 *
 * Patterns:
 *   - `mcp.read.*`  → matches `mcp.read.portfolio`, `mcp.read.audit`, …
 *   - `mcp.read.portfolio` → exact match
 *
 * Wildcard `*` is only valid as the last dot-segment.
 */
export function withScope(required: string[]): (handler: VercelHandler) => VercelHandler {
  if (required.length === 0) {
    throw new Error('withScope requires at least one scope pattern');
  }
  for (const r of required) {
    if (r.length === 0 || /\s/.test(r)) {
      throw new Error(`invalid scope pattern: ${JSON.stringify(r)}`);
    }
  }
  return (handler: VercelHandler): VercelHandler => {
    return async (req: VercelRequest, res: VercelResponse): Promise<void> => {
      const authPayload = (req as AuthenticatedRequest).authPayload;
      if (!authPayload) {
        sendResponse(res, Response.unauthorized('Missing authorization', 'Auth required'));
        return;
      }
      const granted = authPayload.scope;
      // Unscoped legacy tokens: full access. Wave 5 will require explicit
      // scopes everywhere and remove this fallback.
      if (granted === undefined) return handler(req, res);

      const ok = required.every((req) => grantsScope(granted, req));
      if (!ok) {
        sendResponse(
          res,
          Response.forbidden(
            'Insufficient scope',
            `token does not grant required scope: ${required.join(', ')}`,
          ),
        );
        return;
      }
      return handler(req, res);
    };
  };
}

export function grantsScope(granted: readonly string[], required: string): boolean {
  for (const g of granted) {
    if (matchesPattern(g, required)) return true;
  }
  return false;
}

function matchesPattern(grantedPattern: string, required: string): boolean {
  if (grantedPattern === '*') return true;
  if (grantedPattern === required) return true;
  if (grantedPattern.endsWith('.*')) {
    const prefix = grantedPattern.slice(0, -2);
    return required === prefix || required.startsWith(prefix + '.');
  }
  return false;
}
