import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { Surface, SURFACE_VALUES } from '../../../../src/domain/agent/model/surface.enum.js';
import { container } from '../../../../src/infrastructure/container.js';
import { createHandler, sendResponse } from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withRole } from '../../../../src/interface/middleware/with-role.js';
import { withScope } from '../../../../src/interface/middleware/with-scope.js';
import { Response } from '../../../../src/interface/response.js';

/**
 * Wave 4 §5 Path C — POST /api/v1/agent/tools/commit_create_checkout.
 *
 * Dedicated commit endpoint for the create_checkout ActionDescriptor. The
 * standard /tools/commit route only records audit (the on-chain leg
 * happens frontend-side via the SDK). create_checkout is different —
 * the session mint runs server-side at commit because the AES-256-GCM
 * key + fragment surface are server primitives.
 *
 * The response carries the buyer URL + sessionId + fragmentKey ONCE.
 *
 * Defense-in-depth (sec-review HIGH-2 fix):
 *   - `withRole('issuer')` at the HTTP boundary so an investor JWT
 *     cannot burn another issuer's pending confirm token.
 *   - `actionPayload` capped at 16 keys + structural validation inside
 *     the use-case (CommitCreateCheckoutActionPayloadSchema). The
 *     top-level cap blocks a DoS via a deeply-nested unconstrained
 *     `z.record(z.unknown())` (sec-review MEDIUM-1).
 */
const MAX_ACTION_PAYLOAD_KEYS = 16;

const CommitCreateCheckoutSchema = z
  .object({
    confirmToken: z.string().min(8).max(128),
    surface: z
      .enum(SURFACE_VALUES as readonly [Surface, ...Surface[]])
      .optional(),
    /** Echoed back from the ActionDescriptor preview — byte-for-byte
     *  match against the propose-time hash is the consume gate. Capped
     *  at ≤16 top-level keys to bound the worst-case
     *  `ConfirmTokenService.hashAction` stableStringify recursion. */
    actionPayload: z
      .record(z.string(), z.unknown())
      .refine((v) => Object.keys(v).length <= MAX_ACTION_PAYLOAD_KEYS, {
        message: `actionPayload must have ≤${MAX_ACTION_PAYLOAD_KEYS} top-level keys`,
      }),
  })
  .strict();

const handler = createHandler({
  operationName: 'AgentToolCommitCreateCheckout',
  schema: CommitCreateCheckoutSchema,
  execute: async (dto, _req, authPayload) => {
    const result = await container.commitCreateCheckout.execute({
      userId: authPayload!.userId,
      surface: dto.surface ?? Surface.HavenBot,
      confirmToken: dto.confirmToken,
      actionPayload: dto.actionPayload,
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

export default withCors(
  withAuth(withScope(['mcp.propose.*'])(withRole('issuer', router))),
);
