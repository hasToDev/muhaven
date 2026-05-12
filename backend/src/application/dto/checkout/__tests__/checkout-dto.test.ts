import { describe, expect, it } from 'vitest';
import {
  CreateCheckoutSessionDtoSchema,
} from '../checkout.dto.js';
import { ProposeCreateCheckoutDtoSchema } from '../../agent/issuer-tool.dto.js';

/**
 * Wave 4 §5 Path D + C — DTO-level URL scheme validation tests (sec-review
 * HIGH-1 fix). The prior `z.string().url()` accepted `javascript:`,
 * `data:`, `vbscript:`, `file:`, and any private hostname. The
 * `checkoutRedirectUrl()` / `urlSchema` validators reject those.
 *
 * Both validators MUST keep parity — the dashboard path and the agent
 * path persist into the same `metadata.successUrl` column; a divergent
 * posture would let one surface store a URL the other refuses to render.
 */

function makeValidCreateMetadata(overrides: Partial<{ successUrl: string; cancelUrl: string }> = {}) {
  return {
    metadata: {
      issuerAddress: '0x' + 'a'.repeat(40),
      tokenAddress: '0x' + 'b'.repeat(40),
      tokenSymbol: 'AURA88',
      description: 'Series A',
      ...(overrides.successUrl !== undefined ? { successUrl: overrides.successUrl } : {}),
      ...(overrides.cancelUrl !== undefined ? { cancelUrl: overrides.cancelUrl } : {}),
    },
    payload: { amountUsd6: '5000000' },
  };
}

function makeValidProposeArgs(overrides: Partial<{ successUrl: string; cancelUrl: string }> = {}) {
  return {
    tokenAddress: '0x' + 'c'.repeat(40),
    amountUsd6: '5000000',
    ...(overrides.successUrl !== undefined ? { successUrl: overrides.successUrl } : {}),
    ...(overrides.cancelUrl !== undefined ? { cancelUrl: overrides.cancelUrl } : {}),
  };
}

describe('Checkout DTO — URL scheme validators (sec-review HIGH-1)', () => {
  describe('CreateCheckoutSessionDtoSchema.metadata.successUrl/cancelUrl', () => {
    it('accepts https:// URLs', () => {
      expect(() =>
        CreateCheckoutSessionDtoSchema.parse(
          makeValidCreateMetadata({ successUrl: 'https://issuer.example/thanks' }),
        ),
      ).not.toThrow();
    });

    it('accepts http://localhost (dev convenience)', () => {
      expect(() =>
        CreateCheckoutSessionDtoSchema.parse(
          makeValidCreateMetadata({ successUrl: 'http://localhost:8080/ok' }),
        ),
      ).not.toThrow();
      expect(() =>
        CreateCheckoutSessionDtoSchema.parse(
          makeValidCreateMetadata({ successUrl: 'http://127.0.0.1:8080/ok' }),
        ),
      ).not.toThrow();
    });

    it('rejects http:// for non-loopback hosts', () => {
      expect(() =>
        CreateCheckoutSessionDtoSchema.parse(
          makeValidCreateMetadata({ successUrl: 'http://issuer.example/thanks' }),
        ),
      ).toThrow();
    });

    it.each([
      ['javascript:alert(1)', 'javascript: XSS vector'],
      ['data:text/html,<script>alert(1)</script>', 'data: XSS vector'],
      ['vbscript:msgbox', 'vbscript: legacy XSS vector'],
      ['file:///etc/passwd', 'file: local-disk read'],
      ['gopher://x.test/_GET / HTTP/1.1', 'gopher: SSRF gadget'],
      ['ftp://internal/x', 'ftp: SSRF gadget'],
    ])('rejects dangerous scheme %s (%s)', (url) => {
      expect(() =>
        CreateCheckoutSessionDtoSchema.parse(
          makeValidCreateMetadata({ successUrl: url }),
        ),
      ).toThrow();
    });

    it('rejects malformed URLs', () => {
      expect(() =>
        CreateCheckoutSessionDtoSchema.parse(
          makeValidCreateMetadata({ successUrl: 'not a url' }),
        ),
      ).toThrow();
    });

    it('cancelUrl shares the same validator as successUrl', () => {
      expect(() =>
        CreateCheckoutSessionDtoSchema.parse(
          makeValidCreateMetadata({ cancelUrl: 'javascript:alert(1)' }),
        ),
      ).toThrow();
    });
  });

  describe('ProposeCreateCheckoutDtoSchema.successUrl/cancelUrl (HavenBot)', () => {
    it('accepts https:// URLs', () => {
      expect(() =>
        ProposeCreateCheckoutDtoSchema.parse(
          makeValidProposeArgs({ successUrl: 'https://issuer.example/thanks' }),
        ),
      ).not.toThrow();
    });

    it.each([
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox',
      'file:///etc/passwd',
    ])('rejects dangerous scheme %s', (url) => {
      expect(() =>
        ProposeCreateCheckoutDtoSchema.parse(
          makeValidProposeArgs({ successUrl: url }),
        ),
      ).toThrow();
    });

    it('rejects http:// for non-loopback (parity with dashboard schema)', () => {
      expect(() =>
        ProposeCreateCheckoutDtoSchema.parse(
          makeValidProposeArgs({ successUrl: 'http://issuer.example/thanks' }),
        ),
      ).toThrow();
    });

    it('accepts http://localhost (parity with dashboard schema)', () => {
      expect(() =>
        ProposeCreateCheckoutDtoSchema.parse(
          makeValidProposeArgs({ cancelUrl: 'http://localhost:9000/c' }),
        ),
      ).not.toThrow();
    });
  });
});
