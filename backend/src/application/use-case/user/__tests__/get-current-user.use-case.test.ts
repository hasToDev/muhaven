import { describe, expect, it, beforeEach } from 'vitest';
import { GetCurrentUserUseCase } from '../get-current-user.use-case.js';
import {
  MemoryUserRepository,
  MemoryTelegramLinkRepository,
} from '../../../../infrastructure/repository/memory/index.js';
import { User } from '../../../../domain/auth/model/user.js';
import { TelegramLink } from '../../../../domain/agent/model/telegram-link.js';

const NOW = new Date('2026-05-15T00:00:00.000Z');
const LATER = new Date('2026-05-15T01:00:00.000Z');

describe('GetCurrentUserUseCase — Plan A /me telegram_link extension', () => {
  let userRepo: MemoryUserRepository;
  let linkRepo: MemoryTelegramLinkRepository;

  beforeEach(async () => {
    userRepo = new MemoryUserRepository();
    linkRepo = new MemoryTelegramLinkRepository();
    await userRepo.save(
      new User({
        id: 'u_test',
        walletAddress: '0x' + '1'.repeat(40),
        walletProvider: 'zerodev',
        role: 'investor',
        createdAt: NOW,
      }),
    );
  });

  it('returns telegram_link=null when no link exists', async () => {
    const uc = new GetCurrentUserUseCase(userRepo, linkRepo);
    const me = await uc.execute('u_test');
    expect(me.telegram_link).toBeNull();
  });

  it('returns telegram_link=null when only unlinked rows exist', async () => {
    await linkRepo.upsertLink(
      new TelegramLink({
        telegramChatId: '111',
        telegramUserId: '111',
        userId: 'u_test',
        telegramUsername: 'alice_unlinked',
        linkedAt: NOW,
        unlinkedAt: LATER,
        lastActiveAt: null,
      }),
    );
    const uc = new GetCurrentUserUseCase(userRepo, linkRepo);
    const me = await uc.execute('u_test');
    expect(me.telegram_link).toBeNull();
  });

  it('surfaces the most-recently-linked active row', async () => {
    await linkRepo.upsertLink(
      new TelegramLink({
        telegramChatId: '111',
        telegramUserId: '111',
        userId: 'u_test',
        telegramUsername: 'alice_old',
        linkedAt: NOW,
        unlinkedAt: null,
        lastActiveAt: null,
      }),
    );
    await linkRepo.upsertLink(
      new TelegramLink({
        telegramChatId: '222',
        telegramUserId: '222',
        userId: 'u_test',
        telegramUsername: 'alice_new',
        linkedAt: LATER,
        unlinkedAt: null,
        lastActiveAt: null,
      }),
    );
    const uc = new GetCurrentUserUseCase(userRepo, linkRepo);
    const me = await uc.execute('u_test');
    expect(me.telegram_link).toEqual({
      linked: true,
      telegram_chat_id: '222',
      telegram_username: 'alice_new',
      linked_at: LATER.toISOString(),
    });
  });

  it('omits telegram_link entirely when no repo is injected (backwards-compat)', async () => {
    const uc = new GetCurrentUserUseCase(userRepo);
    const me = await uc.execute('u_test');
    // Backwards-compatible: the field is null (not undefined) — wire
    // shape stays predictable for the frontend.
    expect(me.telegram_link).toBeNull();
  });
});
