import { Surface } from '../../../../src/domain/agent/model/surface.enum.js';
import { LinkTelegramDtoSchema } from '../../../../src/application/dto/agent/tool.dto.js';
import { container } from '../../../../src/infrastructure/container.js';
import { createHandler } from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withScope } from '../../../../src/interface/middleware/with-scope.js';
import { Response } from '../../../../src/interface/response.js';

/**
 * POST /api/v1/agent/tools/link_telegram — REST surface for the
 * Q4 Part B `muhaven_link_telegram` HavenBot tool. Mints a single-use
 * Telegram link code via the same dispatcher path the streaming chat
 * uses; returns `{linkCode, expiresInSec, botStartUrl, kind}`.
 *
 * Read-tool — no policy gate, no confirm token. The link-consume side
 * stays the bot worker's responsibility (`/api/v1/agent/openclaw/link/consume`).
 */
const handler = createHandler({
  operationName: 'AgentToolLinkTelegram',
  schema: LinkTelegramDtoSchema,
  execute: async (dto, _req, authPayload) => {
    const result = await container.toolDispatcher.dispatch(
      {
        userId: authPayload!.userId,
        walletAddress: authPayload!.walletAddress,
        surface: Surface.HavenBot,
      },
      'muhaven_link_telegram',
      dto,
    );
    return Response.ok(result);
  },
});

export default withCors(withAuth(withScope(['mcp.read.*'])(handler)));
