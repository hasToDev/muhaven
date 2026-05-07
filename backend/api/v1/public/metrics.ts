/**
 * Wave 4 P9 — public unauthenticated metrics endpoint.
 *
 * Mirrors `public/escrows/[publicId].ts`: `withCors(handler)` only, no
 * auth middleware. Aggregate-only counts; the privacy story (no
 * cleartext amounts, no per-investor data) is enforced by what the
 * indexer captures + the use-case shape, not by this layer.
 */
import { container } from '../../../src/infrastructure/container.js';
import { createGetHandler } from '../../../src/interface/handler-factory.js';
import { withCors } from '../../../src/interface/middleware/with-cors.js';
import { Response } from '../../../src/interface/response.js';

const handler = createGetHandler({
  operationName: 'GetPublicMetrics',
  execute: async () => Response.ok(await container.publicMetricsUseCase.execute()),
});

export default withCors(handler);
