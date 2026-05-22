import { z } from 'zod';
import {
  toUserStateDto,
  type PolicyStateResponseDto,
} from '../../../../src/application/dto/agent/policy.dto.js';
import { GetPolicyStateUseCase } from '../../../../src/application/use-case/agent/policy/get-policy-state.use-case.js';
import { container } from '../../../../src/infrastructure/container.js';
import {
  createGetHandler,
  sendResponse,
} from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withScope } from '../../../../src/interface/middleware/with-scope.js';
import { Response } from '../../../../src/interface/response.js';
import { SURFACE_VALUES, type Surface } from '../../../../src/domain/agent/model/surface.enum.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const getUseCase = new GetPolicyStateUseCase(container.agentStateRepo);

const surfaceQuerySchema = z.enum(SURFACE_VALUES as readonly [Surface, ...Surface[]]).optional();

const getHandler = createGetHandler({
  operationName: 'GetAgentPolicyState',
  execute: async (req, authPayload) => {
    const userId = authPayload!.userId;
    // Wave 5 Path D Pickup A follow-up — accountAddress MUST be the
    // on-chain kernel smart-account address (0x-prefixed 20-byte hex),
    // NOT the JWT subject (which is a UUID). The MCP server's Path D
    // probe at `handlers.ts::attemptPathD` enforces
    // `^0x[0-9a-fA-F]{40}$` on this field and a UUID can never match
    // → `no_validator_registered` for every user, every call. The
    // walletAddress claim on the auth payload IS the kernel address
    // (per `verify-wallet.use-case.ts` SIWE flow). Original code
    // surfaced the documentation gap (DTO comment said "= JWT subject"
    // which was wrong); fixed in the same diff.
    const accountAddress = authPayload!.walletAddress;
    const surfaceQuery = (req.query as Record<string, string | string[] | undefined>).surface;
    const surfaceValue = Array.isArray(surfaceQuery) ? surfaceQuery[0] : surfaceQuery;
    const parsed = surfaceQuerySchema.parse(surfaceValue);

    if (parsed) {
      const state = await getUseCase.forSurface(userId, parsed);
      const dto: PolicyStateResponseDto = {
        accountAddress,
        surfaces: [toUserStateDto(state)],
      };
      return Response.ok(dto);
    }
    const states = await getUseCase.forAllSurfaces(userId);
    const dto: PolicyStateResponseDto = {
      accountAddress,
      surfaces: states.map(toUserStateDto),
    };
    return Response.ok(dto);
  },
});

const router = async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  if (req.method === 'GET') return getHandler(req, res);
  sendResponse(res, Response.badRequest('Method not allowed'));
};

// Wave 4 P3 ADR-3 D2: device-flow JWTs need mcp.read.*; SIWE tokens fall through.
export default withCors(withAuth(withScope(['mcp.read.*'])(router)));
