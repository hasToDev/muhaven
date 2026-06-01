import { Surface } from '../../../../src/domain/agent/model/surface.enum.js';
import { Tier } from '../../../../src/domain/agent/model/tier.enum.js';
import {
  AgentChatStreamDtoSchema,
  type StreamEvent,
} from '../../../../src/application/dto/agent/chat-stream.dto.js';
import { container } from '../../../../src/infrastructure/container.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withScope } from '../../../../src/interface/middleware/with-scope.js';
import { withRateLimit } from '../../../../src/interface/middleware/with-rate-limit.js';
import type { AuthenticatedRequest } from '../../../../src/interface/handler-factory.js';
import type { VercelResponse } from '@vercel/node';
import { getLogger } from '../../../../src/core/logger.js';

const logger = getLogger('AgentChatStream');

/**
 * POST /api/v1/agent/chat/stream  →  SSE-style streaming response.
 *
 * Wave 4 P2 — replaces the keyword-matching stub at /agent/chat with a
 * real Gemini tool-loop. The body is a JSON `AgentChatStreamDto`
 * (message + history). The response is a long-lived stream of newline-
 * delimited `data: {JSON-StreamEvent}\n\n` blocks per SSE convention.
 *
 * The frontend `useAgentChat` composable consumes the stream via the
 * Fetch API's `response.body` ReadableStream — NOT EventSource (which
 * only supports GET). This pattern matches Vercel AI SDK's `useChat`
 * shape so a future Wave 5 swap to that hook is mechanical.
 *
 * Auth: dashboard SIWE bearer (existing `withAuth`). Tool dispatches
 * inherit the user identity through the dispatcher context.
 */
const handler = async (req: AuthenticatedRequest, res: VercelResponse): Promise<void> => {
  if (req.method !== 'POST') {
    res.status(405);
    res.setHeader('Content-Type', 'application/json');
    res.send({ error: 'Method not allowed' });
    return;
  }
  const authPayload = req.authPayload!;

  // Parse body — `req.body` is already JSON-parsed by the dev-server's
  // body parser. The Vercel runtime parses application/json body for us.
  let body: unknown;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    res.status(400);
    res.setHeader('Content-Type', 'application/json');
    res.send({ error: 'Invalid JSON body' });
    return;
  }
  const parse = AgentChatStreamDtoSchema.safeParse(body);
  if (!parse.success) {
    res.status(400);
    res.setHeader('Content-Type', 'application/json');
    res.send({
      error: 'validation_failed',
      issues: parse.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return;
  }
  const dto = parse.data;

  // Pull the user's current tier on the HavenBot surface so the LLM can
  // shape its prompt + the dispatcher can refuse off-tier proposals
  // before the LLM ever sees them. The state read is cheap (single repo
  // call); it's worth the round-trip for the cleaner LLM context.
  const stateUseCase =
    new (await import('../../../../src/application/use-case/agent/policy/get-policy-state.use-case.js')).GetPolicyStateUseCase(
      container.agentStateRepo,
    );
  const state = await stateUseCase.forSurface(authPayload.userId, Surface.HavenBot);

  // Resolve the active RWA token catalog so the planner LLM can map
  // user-spoken symbols ("TBILL1", "GOLD1") to concrete tokenAddress
  // arguments without prompting the user. Uses the indexer's
  // `rwa_tokens` table — same source as the public /metrics page —
  // so the catalog tracks staging vs prod redeployments automatically.
  // The repo read is one row per active token (low single-digit
  // count today); negligible overhead per chat turn.
  const allTokens = await container.rwaTokenRepo.findAll();
  const tokenCatalog = allTokens
    .filter((t) => t.status === 'active' || t.status === 'paused')
    .map((t) => ({
      symbol: t.symbol,
      address: t.address,
      assetClass: t.assetClass,
      status: t.status,
    }));

  // SSE headers.
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write('retry: 10000\n\n');

  let closed = false;
  const sink = (event: StreamEvent): void => {
    if (closed) return;
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'SSE write failed; closing stream',
      );
      closed = true;
    }
  };

  req.on('close', () => {
    closed = true;
  });

  try {
    await container.chatLlmService.streamChat(
      {
        userId: authPayload.userId,
        walletAddress: authPayload.walletAddress,
        surface: Surface.HavenBot,
        currentTier: state.tier as Tier,
        message: dto.message,
        history: (dto.history ?? []).map((m) => ({ role: m.role, text: m.text })),
        tokenCatalog,
        dispatchTool: async (toolName, args) => {
          // Dispatch via the same uniform dispatcher used by the per-tool
          // REST endpoints. The dispatcher re-parses args through the
          // strict schemas — defense in depth against schema-bypass via
          // hallucinated tool calls.
          return container.toolDispatcher.dispatch(
            {
              userId: authPayload.userId,
              walletAddress: authPayload.walletAddress,
              surface: Surface.HavenBot,
            },
            toolName,
            args,
          );
        },
      },
      sink,
    );
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'streamChat threw',
    );
    sink({ type: 'error', message: 'The agent stream errored. Please retry your message.' });
    sink({ type: 'done', finishReason: 'error' });
  } finally {
    if (!closed) {
      res.end();
    }
  }
};

// Wave 4 P2 — chat-stream dispatches WRITE tools (propose_*, set_policy,
// pause). Scope-gate matches the proposal endpoints. Read-only-scoped
// device-flow JWTs hitting this endpoint will get a 403 from withScope
// before any prompt reaches the LLM.
//
// Per-user rate limit (innermost, so it runs AFTER withAuth populates
// `authPayload`): caps how many chat turns a single authenticated user can
// fire per minute. Each turn can drive up to MAX_TOOL_TURNS Gemini round
// trips, so this is the primary guard against a logged-in user abusing the
// agent as a free general-purpose LLM (cost / quota abuse). Keyed by userId
// (not IP) so it can't be sidestepped by rotating X-Forwarded-For, and so
// shared-NAT users don't collide. 20/min is generous for a human operating
// a copilot; tune via the config below if needed. Over-limit returns a
// plain JSON 429 before any SSE header is written.
export default withCors(
  withAuth(
    withScope(['mcp.propose.*'])(
      withRateLimit(
        {
          maxRequests: 20,
          windowSeconds: 60,
          keyFn: (req) => {
            const ap = (req as AuthenticatedRequest).authPayload;
            return ap?.userId ? `chat:${ap.userId}` : 'chat:anon';
          },
        },
        handler,
      ),
    ),
  ),
);
