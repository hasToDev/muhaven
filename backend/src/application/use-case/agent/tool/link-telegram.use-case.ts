import { IssueTelegramLinkCodeUseCase } from '../openclaw/telegram-link.use-case.js';
import type { LinkTelegramToolResult } from '../../../dto/agent/tool.dto.js';

/**
 * Q4 Part B (2026-05-15) — `muhaven_link_telegram` HavenBot tool.
 *
 * Thin wrapper around `IssueTelegramLinkCodeUseCase` shaped for the
 * agentic loop's tool surface. The LLM emits a tool_call without
 * arguments; the result carries the linkCode + bot-start URL the
 * frontend renders as an inline action card. The link-consume side
 * remains the bot worker's responsibility — this tool only mints
 * a single-use code with a 5-minute TTL.
 *
 * The botStartUrl resolution is moved into the route handler (which
 * has access to env vars) — the use-case stays pure for testing.
 */
export interface LinkTelegramToolContext {
  userId: string;
  /** Resolves the bot-start URL from the linkCode. Closure over the
   *  process env so the use-case stays decoupled from getEnv(). When
   *  TELEGRAM_BOT_USERNAME is unset, pass a function that returns null
   *  and the modal will fall back to a manual `/start <code>` flow. */
  botStartUrlResolver: (linkCode: string) => string | null;
}

export class LinkTelegramToolUseCase {
  constructor(private readonly issueLinkCode: IssueTelegramLinkCodeUseCase) {}

  async execute(
    ctx: LinkTelegramToolContext,
    now: Date = new Date(),
  ): Promise<LinkTelegramToolResult> {
    const issued = await this.issueLinkCode.execute(ctx.userId, now);
    return {
      tool: 'muhaven_link_telegram',
      kind: 'link_telegram',
      linkCode: issued.linkCode,
      expiresInSec: issued.expiresInSec,
      botStartUrl: ctx.botStartUrlResolver(issued.linkCode),
    };
  }
}
