import { GetTokenByAddressUseCase } from '../../../src/application/use-case/token/get-tokens.use-case.js';
import { container } from '../../../src/infrastructure/container.js';
import { createGetHandler } from '../../../src/interface/handler-factory.js';
import { withCors } from '../../../src/interface/middleware/with-cors.js';
import { Response } from '../../../src/interface/response.js';
import { getEnv, parseTokenAddressMap } from '../../../src/core/config.js';

const useCase = new GetTokenByAddressUseCase(
  container.rwaTokenRepo,
  container.navHistoryRepo,
  container.userRepo,
  container.oracleRepo,
  // Wave 5 Slice 1 (MCP sell) — per-token RedemptionQueue map.
  parseTokenAddressMap(getEnv().REDEMPTION_QUEUE_BY_TOKEN_JSON),
  // Wave 5 Slice 2c follow-up WS-B — YIELD_SNAPSHOT_ADDRESS env fallback.
  getEnv().YIELD_SNAPSHOT_ADDRESS?.trim() || null,
);

const handler = createGetHandler({
  operationName: 'GetTokenByAddress',
  execute: async (req) => {
    const address = req.query.address as string;
    const result = await useCase.execute(address);
    if (!result) {
      return Response.notFound('Token not found', `No token registered at ${address}`);
    }
    return Response.ok(result);
  },
});

export default withCors(handler);
