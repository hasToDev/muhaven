import { describe, expect, it } from 'vitest';
import {
  formatExpiresAt,
  formatUsdFromBaseUnits,
  renderIntentPreview,
  renderOtpMessage,
  validateIntentNotificationBody,
  type IntentNotificationBody,
} from '../src/intent-notify.js';

const VALID_INTENT_ID = 'oci_AAAAAAAAAAAAAAAAAAAAAAAAAA';
const VALID_HASH = 'a'.repeat(64);
const VALID_TOKEN = '0x1111111111111111111111111111111111111111';
const VALID_EXPIRES = '2026-05-10T00:05:00.000Z';

function inlineBody(overrides: Partial<IntentNotificationBody> = {}): IntentNotificationBody {
  return {
    telegramChatId: '12345',
    intent: {
      intentId: VALID_INTENT_ID,
      kind: 'buy',
      tier: 'inline',
      amountUsd6: '50000000',
      intentHash: VALID_HASH,
      expiresAt: VALID_EXPIRES,
      payload: { token: VALID_TOKEN, summary: 'Buy $50 of TBILL1' },
    },
    ...overrides,
  };
}

describe('validateIntentNotificationBody', () => {
  it('accepts a well-formed inline body', () => {
    const result = validateIntentNotificationBody(inlineBody());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.intent.tier).toBe('inline');
      expect(result.value.otp).toBeUndefined();
    }
  });

  it('accepts a mid-tier body with OTP', () => {
    const result = validateIntentNotificationBody({
      telegramChatId: '12345',
      intent: {
        intentId: VALID_INTENT_ID,
        kind: 'buy',
        tier: 'mini_app_otp',
        amountUsd6: '1500000000',
        intentHash: VALID_HASH,
        expiresAt: VALID_EXPIRES,
        payload: { token: VALID_TOKEN, summary: 'Buy $1500 of TBILL1' },
      },
      otp: '123456',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.intent.tier).toBe('mini_app_otp');
      expect(result.value.otp).toBe('123456');
    }
  });

  it('accepts a high-tier body without OTP', () => {
    const result = validateIntentNotificationBody({
      telegramChatId: '12345',
      intent: {
        intentId: VALID_INTENT_ID,
        kind: 'buy',
        tier: 'passkey_deeplink',
        amountUsd6: '25000000000',
        intentHash: VALID_HASH,
        expiresAt: VALID_EXPIRES,
        payload: { token: VALID_TOKEN, summary: 'Buy $25000 of TBILL1' },
      },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects null body', () => {
    const result = validateIntentNotificationBody(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('malformed body');
  });

  it('rejects malformed telegramChatId', () => {
    const result = validateIntentNotificationBody(inlineBody({ telegramChatId: 'abc' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid telegramChatId');
  });

  it('accepts negative chat-id (supergroups)', () => {
    const result = validateIntentNotificationBody(
      inlineBody({ telegramChatId: '-1001234567890' }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects malformed intentId', () => {
    const r = validateIntentNotificationBody({
      telegramChatId: '12345',
      intent: {
        intentId: 'bad-id',
        kind: 'buy',
        tier: 'inline',
        amountUsd6: '50000000',
        intentHash: VALID_HASH,
        expiresAt: VALID_EXPIRES,
        payload: { token: VALID_TOKEN, summary: 'Buy' },
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid intent.intentId');
  });

  it('rejects unknown kind', () => {
    const r = validateIntentNotificationBody({
      telegramChatId: '12345',
      intent: {
        intentId: VALID_INTENT_ID,
        kind: 'rebalance',
        tier: 'inline',
        amountUsd6: '50000000',
        intentHash: VALID_HASH,
        expiresAt: VALID_EXPIRES,
        payload: { token: VALID_TOKEN, summary: 'Buy' },
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid intent.kind');
  });

  it('rejects unknown tier', () => {
    const r = validateIntentNotificationBody({
      telegramChatId: '12345',
      intent: {
        intentId: VALID_INTENT_ID,
        kind: 'buy',
        tier: 'cosmic_otp',
        amountUsd6: '50000000',
        intentHash: VALID_HASH,
        expiresAt: VALID_EXPIRES,
        payload: { token: VALID_TOKEN, summary: 'Buy' },
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid intent.tier');
  });

  it('rejects non-numeric amountUsd6', () => {
    const r = validateIntentNotificationBody({
      telegramChatId: '12345',
      intent: {
        intentId: VALID_INTENT_ID,
        kind: 'buy',
        tier: 'inline',
        amountUsd6: '50.00',
        intentHash: VALID_HASH,
        expiresAt: VALID_EXPIRES,
        payload: { token: VALID_TOKEN, summary: 'Buy' },
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid intent.amountUsd6');
  });

  it('rejects malformed token address', () => {
    const r = validateIntentNotificationBody({
      telegramChatId: '12345',
      intent: {
        intentId: VALID_INTENT_ID,
        kind: 'buy',
        tier: 'inline',
        amountUsd6: '50000000',
        intentHash: VALID_HASH,
        expiresAt: VALID_EXPIRES,
        payload: { token: 'not-an-address', summary: 'Buy' },
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid intent.payload.token');
  });

  it('rejects > 280-char summary', () => {
    const r = validateIntentNotificationBody({
      telegramChatId: '12345',
      intent: {
        intentId: VALID_INTENT_ID,
        kind: 'buy',
        tier: 'inline',
        amountUsd6: '50000000',
        intentHash: VALID_HASH,
        expiresAt: VALID_EXPIRES,
        payload: { token: VALID_TOKEN, summary: 'x'.repeat(281) },
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid intent.payload.summary');
  });

  it('rejects malformed OTP', () => {
    const r = validateIntentNotificationBody({
      telegramChatId: '12345',
      intent: {
        intentId: VALID_INTENT_ID,
        kind: 'buy',
        tier: 'mini_app_otp',
        amountUsd6: '1500000000',
        intentHash: VALID_HASH,
        expiresAt: VALID_EXPIRES,
        payload: { token: VALID_TOKEN, summary: 'Buy' },
      },
      otp: 'abcdef',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid otp');
  });

  it('rejects OTP on a non-mini_app_otp tier (defense in depth)', () => {
    const r = validateIntentNotificationBody({
      telegramChatId: '12345',
      intent: {
        intentId: VALID_INTENT_ID,
        kind: 'buy',
        tier: 'inline',
        amountUsd6: '50000000',
        intentHash: VALID_HASH,
        expiresAt: VALID_EXPIRES,
        payload: { token: VALID_TOKEN, summary: 'Buy' },
      },
      otp: '123456',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('otp present on non-mini_app_otp tier');
  });

  it('accepts optional issuerLabel + escrowId', () => {
    const r = validateIntentNotificationBody({
      telegramChatId: '12345',
      intent: {
        intentId: VALID_INTENT_ID,
        kind: 'claim',
        tier: 'inline',
        amountUsd6: '50000000',
        intentHash: VALID_HASH,
        expiresAt: VALID_EXPIRES,
        payload: {
          token: VALID_TOKEN,
          summary: 'Claim escrow #42',
          issuerLabel: 'TBILL Token',
          escrowId: '42',
        },
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.intent.payload.issuerLabel).toBe('TBILL Token');
      expect(r.value.intent.payload.escrowId).toBe('42');
    }
  });
});

describe('formatUsdFromBaseUnits', () => {
  it('formats $50.00', () => {
    expect(formatUsdFromBaseUnits('50000000')).toBe('$50.00');
  });

  it('formats sub-dollar', () => {
    expect(formatUsdFromBaseUnits('1234')).toBe('$0.00');
    expect(formatUsdFromBaseUnits('123456')).toBe('$0.12');
  });

  it('formats with thousand separators', () => {
    expect(formatUsdFromBaseUnits('1500000000')).toBe('$1,500.00');
    expect(formatUsdFromBaseUnits('25000000000')).toBe('$25,000.00');
  });
});

describe('formatExpiresAt', () => {
  it('renders HH:MM UTC', () => {
    expect(formatExpiresAt('2026-05-10T05:30:00.000Z')).toBe('05:30 UTC');
    expect(formatExpiresAt('2026-05-10T23:59:00.000Z')).toBe('23:59 UTC');
  });

  it('returns the raw string for malformed ISO input', () => {
    expect(formatExpiresAt('not-an-iso')).toBe('not-an-iso');
  });
});

describe('renderIntentPreview', () => {
  const baseIntent = {
    intentId: VALID_INTENT_ID,
    kind: 'buy' as const,
    tier: 'inline' as const,
    amountUsd6: '50000000',
    intentHash: VALID_HASH,
    expiresAt: VALID_EXPIRES,
    payload: { token: VALID_TOKEN, summary: 'Buy $50 of TBILL1', issuerLabel: 'TBILL Token' },
  };

  it('renders an inline-tier preview with the right CTA hint', () => {
    const text = renderIntentPreview(baseIntent);
    expect(text).toContain('Buy 0x1111');
    expect(text).toContain('Issuer: TBILL Token');
    expect(text).toContain('Amount: $50\\.00');
    expect(text).toContain('Inline confirm');
    expect(text).toContain('Tap *Confirm* to submit');
  });

  it('switches the CTA copy + tier tag for mid-tier', () => {
    const text = renderIntentPreview({ ...baseIntent, tier: 'mini_app_otp' });
    expect(text).toContain('Mini App');
    expect(text).toContain('paste the 6\\-digit code');
  });

  it('switches the CTA copy + tier tag for high-tier', () => {
    const text = renderIntentPreview({ ...baseIntent, tier: 'passkey_deeplink' });
    expect(text).toContain('Dashboard passkey');
    expect(text).toContain('Confirm in dashboard');
  });

  it('falls back to "Unverified issuer" when issuerLabel is absent', () => {
    const text = renderIntentPreview({
      ...baseIntent,
      payload: { token: VALID_TOKEN, summary: 'Buy' },
    });
    expect(text).toContain('Unverified issuer');
  });

  it('escapes MarkdownV2 reserved characters in dynamic substrings', () => {
    const text = renderIntentPreview({
      ...baseIntent,
      payload: {
        token: VALID_TOKEN,
        summary: 'Buy 50 (estimate) [TBILL] @ $1.0',
        issuerLabel: 'TBILL.Issuer',
      },
    });
    // Period in issuer label must be escaped.
    expect(text).toContain('TBILL\\.Issuer');
    // Parens / brackets in summary must be escaped.
    expect(text).toContain('Buy 50 \\(estimate\\) \\[TBILL\\]');
  });
});

describe('renderOtpMessage', () => {
  it('wraps the OTP in a code block + adds the do-not-share hint', () => {
    const text = renderOtpMessage('123456');
    expect(text).toContain('verification code');
    expect(text).toContain('`123456`');
    expect(text).toContain('Do not share');
  });
});
