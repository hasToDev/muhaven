import { describe, expect, it } from 'vitest';
import {
  renderOperatorAlert,
  severityEmoji,
  validateOperatorAlertBody,
  type OperatorAlertBody,
} from '../src/operator-alert.js';

function validBody(overrides: Partial<OperatorAlertBody> = {}): OperatorAlertBody {
  return {
    chatId: '12345',
    severity: 'error',
    message: 'ZeroRateError(USYC): ratePerShare floored to 0; every claim would silent-fail to zero.',
    ...overrides,
  };
}

describe('validateOperatorAlertBody', () => {
  it('accepts a well-formed error body', () => {
    const result = validateOperatorAlertBody(validBody());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.chatId).toBe('12345');
      expect(result.value.severity).toBe('error');
      expect(result.value.message).toContain('ZeroRateError');
    }
  });

  it('accepts info severity', () => {
    const result = validateOperatorAlertBody(validBody({ severity: 'info' }));
    expect(result.ok).toBe(true);
  });

  it('accepts warn severity', () => {
    const result = validateOperatorAlertBody(validBody({ severity: 'warn' }));
    expect(result.ok).toBe(true);
  });

  it('accepts negative chat-id (supergroups)', () => {
    const result = validateOperatorAlertBody(validBody({ chatId: '-1001234567890' }));
    expect(result.ok).toBe(true);
  });

  it('rejects null body', () => {
    const result = validateOperatorAlertBody(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('malformed body');
  });

  it('rejects non-object body', () => {
    // @ts-expect-error — exercising the runtime guard
    const result = validateOperatorAlertBody('a string');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('malformed body');
  });

  it('rejects non-numeric chatId', () => {
    const result = validateOperatorAlertBody(validBody({ chatId: 'abc' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid chatId');
  });

  it('rejects chatId longer than 32 digits', () => {
    const result = validateOperatorAlertBody(validBody({ chatId: '1'.repeat(33) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid chatId');
  });

  it('rejects empty message', () => {
    const result = validateOperatorAlertBody(validBody({ message: '' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid message');
  });

  it('rejects non-string message', () => {
    const result = validateOperatorAlertBody(validBody({ message: 12345 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid message');
  });

  it('rejects message above 1024 chars', () => {
    const result = validateOperatorAlertBody(validBody({ message: 'a'.repeat(1025) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('message too long');
  });

  it('accepts message at exactly 1024 chars', () => {
    const result = validateOperatorAlertBody(validBody({ message: 'a'.repeat(1024) }));
    expect(result.ok).toBe(true);
  });

  it('rejects unknown severity', () => {
    const result = validateOperatorAlertBody(validBody({ severity: 'critical' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid severity');
  });

  it('rejects missing severity', () => {
    const result = validateOperatorAlertBody({
      chatId: '12345',
      message: 'hi',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid severity');
  });

  // Round-2 API-Tester HIGH-1 — leading zeros on chatId would bypass
  // the bot's constant-time string-compare pin against
  // OPERATOR_TELEGRAM_CHAT_ID. Validator now rejects.
  it('rejects chatId with leading zeros', () => {
    const result = validateOperatorAlertBody(validBody({ chatId: '00012345' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid chatId');
  });

  it('rejects negative chatId with leading zeros', () => {
    const result = validateOperatorAlertBody(validBody({ chatId: '-0012345' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid chatId');
  });

  it('accepts bare 0 as chatId (legitimate edge case)', () => {
    const result = validateOperatorAlertBody(validBody({ chatId: '0' }));
    expect(result.ok).toBe(true);
  });

  // Round-2 API-Tester HIGH-2 — lone UTF-16 surrogates silent-fail at
  // Telegram → operator never sees the alert. Validator now rejects.
  it('rejects a lone high surrogate in message', () => {
    const result = validateOperatorAlertBody(
      validBody({ message: 'prefix \uD800 suffix' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid utf-16 message');
  });

  it('rejects a lone low surrogate in message', () => {
    const result = validateOperatorAlertBody(
      validBody({ message: 'prefix \uDC00 suffix' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid utf-16 message');
  });

  it('accepts a complete surrogate pair (BMP-outside char like 𝐀)', () => {
    const result = validateOperatorAlertBody(
      validBody({ message: 'math 𝐀 (U+1D400)' }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a high surrogate at end-of-message (no following low)', () => {
    const result = validateOperatorAlertBody(
      validBody({ message: 'ends with high surrogate \uD800' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid utf-16 message');
  });
});

describe('renderOperatorAlert', () => {
  it('prepends the error emoji', () => {
    const text = renderOperatorAlert({
      chatId: '12345',
      severity: 'error',
      message: 'ratePerShare floored to 0',
    });
    expect(text.startsWith('🚨 ')).toBe(true);
  });

  it('prepends the warn emoji', () => {
    const text = renderOperatorAlert({
      chatId: '12345',
      severity: 'warn',
      message: 'NAV stale',
    });
    expect(text.startsWith('⚠️ ')).toBe(true);
  });

  it('prepends the info emoji', () => {
    const text = renderOperatorAlert({
      chatId: '12345',
      severity: 'info',
      message: 'alert-test invoked',
    });
    expect(text.startsWith('ℹ️ ')).toBe(true);
  });

  it('escapes MarkdownV2 reserved chars in the message', () => {
    const text = renderOperatorAlert({
      chatId: '12345',
      severity: 'error',
      message: 'ZeroRateError(USYC=0x1234): apy*nav/365 < 1.',
    });
    // ( ) = . *  → escaped via leading backslash per the MarkdownV2
    // reserved set in `telegram-api.ts:152`. Telegram requires this or
    // it silently drops the message. If any one of these chars sneaks
    // past unescaped, prod sees alerts as 400 from Telegram (and the
    // producer's catch swallows the error → silent operator outage).
    // (`<` and `/` are NOT reserved by Telegram so they pass through.)
    expect(text).toContain('ZeroRateError\\(USYC\\=0x1234\\)');
    expect(text).toContain('apy\\*nav/365 < 1\\.');
  });

  it('preserves multi-line messages', () => {
    const text = renderOperatorAlert({
      chatId: '12345',
      severity: 'error',
      message: 'Token: USYC\nError: ZeroRateError',
    });
    expect(text).toContain('\n');
    expect(text).toContain('Token: USYC');
    expect(text).toContain('Error: ZeroRateError');
  });
});

describe('severityEmoji', () => {
  it('maps every severity to a non-empty string', () => {
    expect(severityEmoji('info').length).toBeGreaterThan(0);
    expect(severityEmoji('warn').length).toBeGreaterThan(0);
    expect(severityEmoji('error').length).toBeGreaterThan(0);
  });

  it('returns distinct emoji per severity', () => {
    const set = new Set([severityEmoji('info'), severityEmoji('warn'), severityEmoji('error')]);
    expect(set.size).toBe(3);
  });
});
