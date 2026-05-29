import type { VercelRequest, VercelResponse } from '@vercel/node';
import { MintEphemeralRequestDtoSchema } from '../../../../src/application/dto/agent/path-d.dto.js';
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
 * POST /api/v1/agent/path-d/mint-ephemeral
 *
 * Wave 5 Path D Slice 2a (autonomous claim) — MCP-server-facing endpoint
 * that mints a throwaway ephemeral EOA for the autonomous-claim UserOp's
 * `YieldSnapshot.claimYield(epochId, ephemeralEOA)` call.
 *
 * Unlike `encrypt-shares`, claim's amount is computed on-chain so there's
 * nothing to encrypt — this route only mints the eph (the FHE.allow
 * decrypt-grant target). It reuses the same revoke kill-switch session
 * gate, so a revoked/expired Scoped session returns 403 → Path-C
 * fallback.
 *
 * Auth: `mcp.propose.*` matches the device-flow scope minted at MCP
 * login (same as encrypt-shares). The mint itself moves nothing on-chain
 * — the broker session key still has to sign the subsequent UserOp.
 */
const handler = createHandler({
  operationName: 'PathDMintEphemeralForClaim',
  schema: MintEphemeralRequestDtoSchema,
  execute: async (dto, _req, authPayload) => {
    const result = await container.mintEphemeralForClaim.execute({
      // JWT subject (UUID) — the revoke kill-switch gate keys the
      // active-session lookup on this.
      userId: authPayload!.userId,
      tokenAddress: dto.tokenAddress,
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

// Rate-limit per JWT subject (mirrors encrypt-shares) so a stolen
// `mcp.propose.*` token can't saturate the route. A claim is 1 call.
const rateLimitedRouter = withRateLimit(
  {
    maxRequests: 10,
    windowSeconds: 60,
    keyFn: (req) => {
      const authPayload = (req as AuthenticatedRequest).authPayload;
      const userId = authPayload?.userId;
      if (typeof userId === 'string' && userId.length > 0) {
        return `mint-ephemeral:${userId}`;
      }
      const ip = req.socket?.remoteAddress ?? 'unknown';
      return `mint-ephemeral:ip:${ip}`;
    },
  },
  router,
);

export default withCors(withAuth(withScope(['mcp.propose.*'])(rateLimitedRouter)));
