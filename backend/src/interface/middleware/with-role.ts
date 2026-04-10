import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { AuthenticatedRequest, VercelHandler } from '../handler-factory.js';
import { Response } from '../response.js';
import { sendResponse } from '../handler-factory.js';

/**
 * Role-based access control middleware.
 * Must be used AFTER withAuth — requires authPayload to be populated.
 *
 * Usage:
 *   export default withCors(withAuth(withRole('issuer', handler)));
 *   export default withCors(withAuth(withRole(['investor', 'issuer'], handler)));
 */
export function withRole(
  allowedRoles: string | string[],
  handler: VercelHandler,
): VercelHandler {
  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];

  return async (req: VercelRequest, res: VercelResponse): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const payload = authReq.authPayload;

    if (!payload) {
      sendResponse(res, Response.unauthorized('Not authenticated', 'Authentication required before role check'));
      return;
    }

    const userRole = payload.role;
    if (!userRole || !roles.includes(userRole)) {
      sendResponse(
        res,
        Response.forbidden(`Insufficient permissions — requires role: ${roles.join(' or ')}`),
      );
      return;
    }

    return handler(req, res);
  };
}
