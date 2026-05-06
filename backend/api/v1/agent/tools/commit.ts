import { z } from 'zod';
import { Surface, SURFACE_VALUES } from '../../../../src/domain/agent/model/surface.enum.js';
import {
  CommitToolActionDtoSchema,
} from '../../../../src/application/dto/agent/tool.dto.js';
import { container } from '../../../../src/infrastructure/container.js';
import { createHandler } from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withScope } from '../../../../src/interface/middleware/with-scope.js';
import { Response } from '../../../../src/interface/response.js';

/**
 * Closes the propose → confirm → commit loop.
 *
 * Frontend calls this AFTER the on-chain UserOp confirms (or `set_policy`
 * forwards through the dedicated /policy/transition route). The body
 * carries the same `actionPayload` shape the ActionDescriptor returned at
 * propose time — the action-hash equality is what makes the consume
 * deterministic.
 */
const CommitDtoSchema = CommitToolActionDtoSchema.extend({
  surface: z
    .enum(SURFACE_VALUES as readonly [Surface, ...Surface[]])
    .optional(),
  actionKind: z.enum(['permit_grant', 'tier_transition']),
  actionPayload: z.record(z.string(), z.unknown()),
}).strict();

const handler = createHandler({
  operationName: 'AgentToolCommit',
  schema: CommitDtoSchema,
  execute: async (dto, _req, authPayload) => {
    const result = await container.commitToolAction.execute(
      authPayload!.userId,
      dto.surface ?? Surface.HavenBot,
      dto.actionPayload,
      dto.actionKind,
      {
        confirmToken: dto.confirmToken,
        txHash: dto.txHash,
        metadata: dto.metadata,
      },
    );
    return Response.ok(result);
  },
});

export default withCors(withAuth(withScope(['mcp.propose.*'])(handler)));
