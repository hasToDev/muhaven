import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  TelegramInitDataInvalidError,
  TelegramInitDataVerifier,
} from '../verify-telegram-init-data.js';

const FIXED_BOT_TOKEN = '111111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const FIXED_USER = { id: 555, username: 'alice' };
const FIXED_AUTH_DATE = 1735689600; // 2025-01-01T00:00:00Z

function buildInitData(opts: {
  botToken?: string;
  authDate?: number;
  user?: { id: number; username?: string };
  startParam?: string;
  /** Pass `false` to omit the hash field entirely (for malformed tests). */
  withHash?: boolean;
  /** Pass to override the hash to a specific value (for mismatch tests). */
  forceHash?: string;
}): string {
  const botToken = opts.botToken ?? FIXED_BOT_TOKEN;
  const authDate = opts.authDate ?? FIXED_AUTH_DATE;
  const user = opts.user ?? FIXED_USER;
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate));
  params.set('user', JSON.stringify(user));
  if (opts.startParam) params.set('start_param', opts.startParam);

  const pairs: { key: string; value: string }[] = [];
  for (const [k, v] of params.entries()) pairs.push({ key: k, value: v });
  pairs.sort((a, b) => (a.key < b.key ? -1 : 1));
  const dataCheck = pairs.map((p) => `${p.key}=${p.value}`).join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = createHmac('sha256', secretKey).update(dataCheck).digest('hex');

  if (opts.withHash !== false) {
    params.set('hash', opts.forceHash ?? computed);
  }
  return params.toString();
}

describe('TelegramInitDataVerifier', () => {
  it('verifies a freshly-signed initData', () => {
    const initData = buildInitData({});
    const verifier = new TelegramInitDataVerifier({
      botToken: FIXED_BOT_TOKEN,
      now: () => new Date(FIXED_AUTH_DATE * 1000 + 60_000), // 1 min later
    });
    const result = verifier.verify(initData);
    expect(result.userId).toBe('555');
    expect(result.username).toBe('alice');
    expect(result.authDateSec).toBe(FIXED_AUTH_DATE);
  });

  it('parses start_param when present', () => {
    const initData = buildInitData({ startParam: 'oci_AAAAAAAAAAAAAAAAAAAAAAAAAA' });
    const verifier = new TelegramInitDataVerifier({
      botToken: FIXED_BOT_TOKEN,
      now: () => new Date(FIXED_AUTH_DATE * 1000 + 1000),
    });
    const result = verifier.verify(initData);
    expect(result.startParam).toBe('oci_AAAAAAAAAAAAAAAAAAAAAAAAAA');
  });

  it('rejects on hash mismatch', () => {
    const initData = buildInitData({ forceHash: 'a'.repeat(64) });
    const verifier = new TelegramInitDataVerifier({
      botToken: FIXED_BOT_TOKEN,
      now: () => new Date(FIXED_AUTH_DATE * 1000 + 1000),
    });
    expect(() => verifier.verify(initData)).toThrow(TelegramInitDataInvalidError);
    try {
      verifier.verify(initData);
    } catch (e) {
      expect((e as TelegramInitDataInvalidError).code).toBe('hash_mismatch');
    }
  });

  it('rejects on missing hash', () => {
    const initData = buildInitData({ withHash: false });
    const verifier = new TelegramInitDataVerifier({
      botToken: FIXED_BOT_TOKEN,
      now: () => new Date(FIXED_AUTH_DATE * 1000 + 1000),
    });
    expect(() => verifier.verify(initData)).toThrow(TelegramInitDataInvalidError);
  });

  it('rejects when initData is older than maxAgeSec', () => {
    const initData = buildInitData({});
    const verifier = new TelegramInitDataVerifier({
      botToken: FIXED_BOT_TOKEN,
      maxAgeSec: 60,
      now: () => new Date(FIXED_AUTH_DATE * 1000 + 120_000),
    });
    expect(() => verifier.verify(initData)).toThrow(TelegramInitDataInvalidError);
    try {
      verifier.verify(initData);
    } catch (e) {
      expect((e as TelegramInitDataInvalidError).code).toBe('stale');
    }
  });

  it('rejects on different bot token', () => {
    const initData = buildInitData({});
    const wrongVerifier = new TelegramInitDataVerifier({
      botToken: '222222222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      now: () => new Date(FIXED_AUTH_DATE * 1000 + 1000),
    });
    expect(() => wrongVerifier.verify(initData)).toThrow(TelegramInitDataInvalidError);
  });

  it('rejects malformed initData (empty)', () => {
    const verifier = new TelegramInitDataVerifier({ botToken: FIXED_BOT_TOKEN });
    expect(() => verifier.verify('')).toThrow(TelegramInitDataInvalidError);
  });

  it('rejects when user field is missing', () => {
    // Build initData without `user` — backend MUST refuse.
    const params = new URLSearchParams();
    params.set('auth_date', String(FIXED_AUTH_DATE));
    const pairs: { key: string; value: string }[] = [];
    for (const [k, v] of params.entries()) pairs.push({ key: k, value: v });
    pairs.sort((a, b) => (a.key < b.key ? -1 : 1));
    const dataCheck = pairs.map((p) => `${p.key}=${p.value}`).join('\n');
    const secretKey = createHmac('sha256', 'WebAppData').update(FIXED_BOT_TOKEN).digest();
    const hash = createHmac('sha256', secretKey).update(dataCheck).digest('hex');
    params.set('hash', hash);
    const verifier = new TelegramInitDataVerifier({
      botToken: FIXED_BOT_TOKEN,
      now: () => new Date(FIXED_AUTH_DATE * 1000 + 1000),
    });
    try {
      verifier.verify(params.toString());
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as TelegramInitDataInvalidError).code).toBe('no_user');
    }
  });

  it('refuses to construct without a bot token', () => {
    expect(() => new TelegramInitDataVerifier({ botToken: '' })).toThrow();
    expect(() => new TelegramInitDataVerifier({ botToken: 'short' })).toThrow();
  });
});
