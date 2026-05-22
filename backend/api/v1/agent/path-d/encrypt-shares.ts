import type { VercelRequest, VercelResponse } from '@vercel/node';
import { EncryptSharesForPurchaseRequestDtoSchema } from '../../../../src/application/dto/agent/path-d.dto.js';
import { container } from '../../../../src/infrastructure/container.js';
import {
  createHandler,
  sendResponse,
  type AuthenticatedRequest,
} from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withRateLimit } from '../../../../src/interface/middleware/with-rate-limit.js';
import { withScope } from '../../../../src/interface/middleware/with-scope.js';
import { Response } from '../../../../src/interface/response.js';

/**
 * POST /api/v1/agent/path-d/encrypt-shares
 *
 * Wave 5 Path D Slice 1 (Commit 3.5) — MCP-server-facing endpoint that
 * encrypts a cleartext `sharesAmount` into the `InEuint128` ciphertext
 * the autonomous-buy UserOp's `subscription.purchase(token, encShares,
 * maxSharesHint, ephemeralEOA)` call needs.
 *
 * The endpoint also mints a fresh-random throwaway ephemeral EOA for
 * the `ephemeralEOA` ACL grant target — see DTO JSDoc for why this is
 * safe.
 *
 * Auth: `mcp.propose.*` matches the device-flow scope minted at MCP
 * login. SIWE tokens (no scope claim) fall through as full-access per
 * the existing back-compat in `withScope`. The encryption itself is
 * not a "write" action on its own — the user-authorized broker session
 * key still has to sign the subsequent UserOp before anything moves
 * on-chain. So the scope is "the LLM is proposing an action," which
 * matches the existing `mcp.propose.*` semantic.
 */
const handler = createHandler({
  operationName: 'PathDEncryptSharesForPurchase',
  schema: EncryptSharesForPurchaseRequestDtoSchema,
  execute: async (dto, _req, authPayload) => {
    const userId = authPayload!.userId;
    const result = await container.encryptSharesForPurchase.execute({
      userId,
      tokenAddress: dto.tokenAddress,
      sharesAmount: BigInt(dto.sharesAmount),
    });
    return Response.ok(result);
  },
});

const router = async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  if (req.method !== 'POST') {
    sendResponse(res, Response.badRequest('Method not allowed'));
    return;
  }
  return handler(req, res);
};

// Wave 5 Path D Slice 1 Commit 3.5 (SecEng round-2 HIGH-1 part b) —
// rate-limit per JWT subject so a stolen `mcp.propose.*` token can't
// saturate the fhe-worker. 10/minute matches the expected operator
// pace (a single Path D buy is 1 call; even a tight LLM-driven loop
// should never need more). Falls back to client IP if the JWT subject
// isn't readable (defense-in-depth — auth middleware already gates).
const rateLimitedRouter = withRateLimit(
  {
    maxRequests: 10,
    windowSeconds: 60,
    keyFn: (req) => {
      const authPayload = (req as AuthenticatedRequest).authPayload;
      const userId = authPayload?.userId;
      if (typeof userId === 'string' && userId.length > 0) {
        return `encrypt-shares:${userId}`;
      }
      // Fallback shouldn't fire post-withAuth, but defensive.
      const ip = req.socket?.remoteAddress ?? 'unknown';
      return `encrypt-shares:ip:${ip}`;
    },
  },
  router,
);

export default withCors(withAuth(withScope(['mcp.propose.*'])(rateLimitedRouter)));
