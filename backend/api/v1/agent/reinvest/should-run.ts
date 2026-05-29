import type { VercelRequest, VercelResponse } from '@vercel/node';
import { container } from '../../../../src/infrastructure/container.js';
import {
  createGetHandler,
  sendResponse,
} from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withScope } from '../../../../src/interface/middleware/with-scope.js';
import { Response } from '../../../../src/interface/response.js';

/**
 * GET /api/v1/agent/reinvest/should-run
 *
 * Wave 5 Slice 2b — the headless reinvest gate (Option A driver). The
 * broker daemon polls this; when `{ shouldRun: true, epochs: [...] }` it
 * signs the atomic claim+buy (2c). The backend cannot sign — it only
 * answers the gate.
 *
 * PUBLIC-DATA only (Q2=c): refuses unless the user has an active Scoped
 * session (revoke kill-switch) that opted in (`reinvest_enabled`), then
 * enumerates claimable epochs via public on-chain reads — no FHE decrypt;
 * the claimable amount stays encrypted (amount-blind).
 *
 * `investorAddress` is sourced from the SIWE/device-flow `walletAddress`
 * claim (the kernel address), NOT the JWT subject UUID. Scope:
 * `mcp.read.*` (a read; the broker's device-flow JWT carries it — same
 * grant the MCP read tools use). SIWE tokens fall through as full-access.
 */
const getHandler = createGetHandler({
  operationName: 'GetReinvestShouldRun',
  execute: async (_req, authPayload) => {
    const result = await container.getReinvestShouldRun.execute({
      userId: authPayload!.userId,
      investorAddress: authPayload!.walletAddress,
    });
    return Response.ok(result);
  },
});

const router = async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  if (req.method === 'GET') return getHandler(req, res);
  sendResponse(res, Response.badRequest('Method not allowed'));
};

export default withCors(withAuth(withScope(['mcp.read.*'])(router)));
