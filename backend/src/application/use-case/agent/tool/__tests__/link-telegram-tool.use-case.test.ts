import { describe, expect, it } from 'vitest';
import { LinkTelegramToolUseCase } from '../link-telegram.use-case.js';
import { IssueTelegramLinkCodeUseCase } from '../../openclaw/telegram-link.use-case.js';
import { MemoryTelegramLinkCodeRepository } from '../../../../../infrastructure/repository/memory/index.js';

const NOW = new Date('2026-05-15T00:00:00.000Z');

describe('LinkTelegramToolUseCase (Q4 Part B)', () => {
  it('mints a 5-min link code + resolves the bot-start URL via the injected resolver', async () => {
    const codeRepo = new MemoryTelegramLinkCodeRepository();
    const issue = new IssueTelegramLinkCodeUseCase(codeRepo);
    const tool = new LinkTelegramToolUseCase(issue);

    const out = await tool.execute(
      {
        userId: 'u1',
        botStartUrlResolver: (code) => `https://t.me/test_bot?start=${code}`,
      },
      NOW,
    );

    expect(out.tool).toBe('muhaven_link_telegram');
    expect(out.kind).toBe('link_telegram');
    expect(out.linkCode).toMatch(/^[A-Z0-9]{8}$/);
    expect(out.expiresInSec).toBe(300);
    expect(out.botStartUrl).toBe(`https://t.me/test_bot?start=${out.linkCode}`);
  });

  it('returns botStartUrl=null when the resolver does (bot username unset)', async () => {
    const codeRepo = new MemoryTelegramLinkCodeRepository();
    const issue = new IssueTelegramLinkCodeUseCase(codeRepo);
    const tool = new LinkTelegramToolUseCase(issue);

    const out = await tool.execute(
      {
        userId: 'u1',
        botStartUrlResolver: () => null,
      },
      NOW,
    );

    expect(out.botStartUrl).toBeNull();
    // The linkCode is still actionable — the modal renders a manual
    // `/start <code>` fallback for environments without TELEGRAM_BOT_USERNAME.
    expect(out.linkCode).toMatch(/^[A-Z0-9]{8}$/);
  });
});
