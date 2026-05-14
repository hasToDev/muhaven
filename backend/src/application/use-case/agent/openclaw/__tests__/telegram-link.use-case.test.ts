import { describe, expect, it, beforeEach } from 'vitest';
import {
  ConsumeTelegramLinkUseCase,
  IssueTelegramLinkCodeUseCase,
  UnlinkTelegramUseCase,
} from '../telegram-link.use-case.js';
import {
  MemoryTelegramLinkCodeRepository,
  MemoryTelegramLinkRepository,
} from '../../../../../infrastructure/repository/memory/index.js';

const NOW = new Date('2026-04-30T00:00:00.000Z');
const SIX_MIN_LATER = new Date(NOW.getTime() + 6 * 60 * 1000);
const ONE_MIN_LATER = new Date(NOW.getTime() + 60 * 1000);

describe('IssueTelegramLinkCodeUseCase', () => {
  it('issues an 8-char base32 code with a 5-minute TTL', async () => {
    const codeRepo = new MemoryTelegramLinkCodeRepository();
    const useCase = new IssueTelegramLinkCodeUseCase(codeRepo);
    const result = await useCase.execute('u1', NOW);
    expect(result.linkCode).toMatch(/^[A-Z0-9]{8}$/);
    expect(result.expiresInSec).toBe(300);
    expect(result.botStartUrl('muhaven_bot')).toBe(
      `https://t.me/muhaven_bot?start=${result.linkCode}`,
    );
  });
});

describe('ConsumeTelegramLinkUseCase', () => {
  let codeRepo: MemoryTelegramLinkCodeRepository;
  let linkRepo: MemoryTelegramLinkRepository;
  let issueCase: IssueTelegramLinkCodeUseCase;
  let consumeCase: ConsumeTelegramLinkUseCase;

  beforeEach(() => {
    codeRepo = new MemoryTelegramLinkCodeRepository();
    linkRepo = new MemoryTelegramLinkRepository();
    issueCase = new IssueTelegramLinkCodeUseCase(codeRepo);
    consumeCase = new ConsumeTelegramLinkUseCase(codeRepo, linkRepo);
  });

  it('binds a chat to a user on the first consume; both chat-id and user-id stored', async () => {
    const issued = await issueCase.execute('u1', NOW);
    const link = await consumeCase.execute({
      linkCode: issued.linkCode,
      telegramChatId: '12345',
      telegramUserId: '12345',
      telegramUsername: 'alice',
      now: ONE_MIN_LATER,
    });
    expect(link.userId).toBe('u1');
    expect(link.telegramChatId).toBe('12345');
    expect(link.telegramUserId).toBe('12345');
    expect(link.telegramUsername).toBe('alice');
    expect(link.isActive()).toBe(true);
  });

  it('rejects re-use of the same code', async () => {
    const issued = await issueCase.execute('u1', NOW);
    await consumeCase.execute({
      linkCode: issued.linkCode,
      telegramChatId: '12345',
      telegramUserId: '12345',
      telegramUsername: 'alice',
      now: ONE_MIN_LATER,
    });
    await expect(
      consumeCase.execute({
        linkCode: issued.linkCode,
        telegramChatId: '99999',
        telegramUserId: '99999',
        telegramUsername: 'eve',
        now: ONE_MIN_LATER,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects after the code TTL expires', async () => {
    const issued = await issueCase.execute('u1', NOW);
    await expect(
      consumeCase.execute({
        linkCode: issued.linkCode,
        telegramChatId: '12345',
        telegramUserId: '12345',
        telegramUsername: 'alice',
        now: SIX_MIN_LATER,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects an unknown link code', async () => {
    await expect(
      consumeCase.execute({
        linkCode: 'XXXXXXXX',
        telegramChatId: '12345',
        telegramUserId: '12345',
        telegramUsername: null,
        now: ONE_MIN_LATER,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('exposes findByTelegramUserId for the Mini App initData path', async () => {
    const issued = await issueCase.execute('u1', NOW);
    await consumeCase.execute({
      linkCode: issued.linkCode,
      telegramChatId: '12345',
      telegramUserId: '12345',
      telegramUsername: 'alice',
      now: ONE_MIN_LATER,
    });
    const found = await linkRepo.findByTelegramUserId('12345');
    expect(found?.userId).toBe('u1');
    const missing = await linkRepo.findByTelegramUserId('67890');
    expect(missing).toBeNull();
  });
});

describe('UnlinkTelegramUseCase (Plan A)', () => {
  let codeRepo: MemoryTelegramLinkCodeRepository;
  let linkRepo: MemoryTelegramLinkRepository;
  let issueCase: IssueTelegramLinkCodeUseCase;
  let consumeCase: ConsumeTelegramLinkUseCase;
  let unlinkCase: UnlinkTelegramUseCase;

  beforeEach(() => {
    codeRepo = new MemoryTelegramLinkCodeRepository();
    linkRepo = new MemoryTelegramLinkRepository();
    issueCase = new IssueTelegramLinkCodeUseCase(codeRepo);
    consumeCase = new ConsumeTelegramLinkUseCase(codeRepo, linkRepo);
    unlinkCase = new UnlinkTelegramUseCase(linkRepo);
  });

  async function linkChat(userId: string, chatId: string, username: string): Promise<void> {
    const issued = await issueCase.execute(userId, NOW);
    await consumeCase.execute({
      linkCode: issued.linkCode,
      telegramChatId: chatId,
      telegramUserId: chatId,
      telegramUsername: username,
      now: ONE_MIN_LATER,
    });
  }

  it('unlinks every active row for the user when chatId is omitted', async () => {
    await linkChat('u1', '111', 'alice_personal');
    await linkChat('u1', '222', 'alice_family');
    const out = await unlinkCase.execute({ userId: 'u1', now: SIX_MIN_LATER });
    expect(out.unlinkedCount).toBe(2);
    const rows = await linkRepo.findByUserId('u1');
    for (const r of rows) {
      expect(r.isActive()).toBe(false);
    }
  });

  it('targets a single chat when chatId is provided', async () => {
    await linkChat('u1', '111', 'alice_personal');
    await linkChat('u1', '222', 'alice_family');
    const out = await unlinkCase.execute({
      userId: 'u1',
      telegramChatId: '111',
      now: SIX_MIN_LATER,
    });
    expect(out.unlinkedCount).toBe(1);
    const a = await linkRepo.findByChatId('111');
    const b = await linkRepo.findByChatId('222');
    expect(a?.isActive()).toBe(false);
    expect(b?.isActive()).toBe(true);
  });

  it('does NOT unlink another user\'s chat even if the chatId is passed', async () => {
    await linkChat('u1', '111', 'alice');
    await linkChat('u2', '222', 'bob');
    // u1 tries to unlink u2's chat — refused at the user-scope filter.
    const out = await unlinkCase.execute({
      userId: 'u1',
      telegramChatId: '222',
      now: SIX_MIN_LATER,
    });
    expect(out.unlinkedCount).toBe(0);
    const b = await linkRepo.findByChatId('222');
    expect(b?.isActive()).toBe(true);
  });

  it('returns 0 idempotently when there are no active links', async () => {
    const out = await unlinkCase.execute({ userId: 'u1', now: NOW });
    expect(out.unlinkedCount).toBe(0);
  });
});
