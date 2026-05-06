import { describe, expect, it } from 'vitest';
import {
  gatePlannerIntent,
  sanitiseToolResult,
  PLANNER_ALLOWED_TOOLS,
} from '../camel-policy-gate.js';
import { ApplicationHttpError } from '../../../../core/errors.js';

const ESC = String.fromCharCode(0x1b);

describe('camel-policy-gate', () => {
  describe('gatePlannerIntent', () => {
    it('allows every documented planner tool', () => {
      for (const t of PLANNER_ALLOWED_TOOLS) {
        const r = gatePlannerIntent({ toolName: t, rawArgs: {} });
        expect(r.toolName).toBe(t);
      }
    });

    it('rejects unknown tool name with bad-request', () => {
      expect(() => gatePlannerIntent({ toolName: 'evil_tool', rawArgs: {} }))
        .toThrow(ApplicationHttpError);
    });

    it('rejects array args', () => {
      expect(() =>
        gatePlannerIntent({ toolName: 'muhaven_quote', rawArgs: ['x', 'y'] }),
      ).toThrow(ApplicationHttpError);
    });

    it('rejects scalar args', () => {
      expect(() =>
        gatePlannerIntent({ toolName: 'muhaven_quote', rawArgs: 'token=ABC' as unknown }),
      ).toThrow(ApplicationHttpError);
    });

    it('rejects __proto__ pollution attempts', () => {
      expect(() =>
        gatePlannerIntent({
          toolName: 'muhaven_propose_buy',
          rawArgs: JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>,
        }),
      ).toThrow(/refusing dispatch/i);
    });

    it('rejects constructor key', () => {
      expect(() =>
        gatePlannerIntent({
          toolName: 'muhaven_propose_buy',
          rawArgs: { constructor: 'evil' } as unknown as Record<string, unknown>,
        }),
      ).toThrow(/refusing dispatch/i);
    });

    it('strips ANSI from string args', () => {
      const r = gatePlannerIntent({
        toolName: 'muhaven_quote',
        rawArgs: { tokenAddress: `0x${ESC}[31mabc`, notionalUsd6: '1000000' },
      });
      expect((r.cleanArgs as Record<string, string>).tokenAddress).toBe('0xabc');
      expect((r.cleanArgs as Record<string, string>).notionalUsd6).toBe('1000000');
      expect(r.argsWereSanitised).toBe(true);
    });

    it('passes through clean args without flagging argsWereSanitised', () => {
      const r = gatePlannerIntent({
        toolName: 'muhaven_quote',
        rawArgs: { tokenAddress: '0xabc', notionalUsd6: '1000000' },
      });
      expect(r.argsWereSanitised).toBe(false);
    });

    it('emits a unique correlationId per call', () => {
      const a = gatePlannerIntent({ toolName: 'muhaven_pause', rawArgs: {} });
      const b = gatePlannerIntent({ toolName: 'muhaven_pause', rawArgs: {} });
      expect(a.correlationId).not.toBe(b.correlationId);
      expect(a.correlationId).toMatch(/^cm_\d+_[a-z0-9]+$/);
    });

    it('passes nullish args through as undefined', () => {
      const r = gatePlannerIntent({ toolName: 'muhaven_pause', rawArgs: null });
      expect(r.cleanArgs).toBeUndefined();
      expect(r.argsWereSanitised).toBe(false);
    });
  });

  describe('sanitiseToolResult', () => {
    it('passes through structured results untouched', () => {
      const input = { ok: true, shares: '12.5', tokenAddress: '0xabc' };
      const out = sanitiseToolResult(input);
      expect(out).toEqual(input);
    });

    it('strips ANSI from nested string fields', () => {
      const input = {
        positions: [{ symbol: `TBI${ESC}[31mLL1`, shares: '10' }],
      };
      const out = sanitiseToolResult(input) as { positions: Array<{ symbol: string }> };
      expect(out.positions[0].symbol).toBe('TBILL1');
    });

    it('strips Tag-block + bidi from result strings', () => {
      const tag = String.fromCodePoint(0xe0041);
      const RLO = String.fromCharCode(0x202e);
      const PDF = String.fromCharCode(0x202c);
      const input = { description: `safe ${RLO}evil${PDF} ${tag}` };
      const out = sanitiseToolResult(input) as { description: string };
      expect(out.description).toBe('safe evil ');
    });
  });
});
