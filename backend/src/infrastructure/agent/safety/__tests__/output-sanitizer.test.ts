import { describe, expect, it } from 'vitest';
import {
  sanitizeText,
  sanitizeJsonValue,
  stripControl,
} from '../output-sanitizer.js';

// Use code-point construction so the test source survives any editor /
// transport that strips ESC / control bytes from string literals.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const NUL = String.fromCharCode(0x00);
const C1_CSI = String.fromCharCode(0x9b);

describe('output-sanitizer', () => {
  describe('sanitizeText', () => {
    it('passes pure ASCII through unchanged', () => {
      const input = 'Hello, this is a benign portfolio summary.';
      expect(sanitizeText(input)).toBe(input);
    });

    it('preserves newlines, tabs, and CR', () => {
      const input = 'Line one\nLine two\tindented\r\n';
      expect(sanitizeText(input)).toBe(input);
    });

    it('strips ANSI CSI sequences', () => {
      const input = `${ESC}[31mERROR${ESC}[0m: rebalance failed`;
      expect(sanitizeText(input)).toBe('ERROR: rebalance failed');
    });

    it('strips ANSI OSC sequences (BEL-terminated)', () => {
      const input = `${ESC}]0;Click here${BEL}safe text`;
      expect(sanitizeText(input)).toBe('safe text');
    });

    it('strips ANSI OSC sequences (ST-terminated)', () => {
      const input = `${ESC}]8;;https://attacker.example.com${ESC}\\benign link${ESC}]8;;${ESC}\\`;
      expect(sanitizeText(input)).toBe('benign link');
    });

    it('strips DEL and C0 control characters except whitespace', () => {
      const input = `safe${NUL}${String.fromCharCode(0x7f)}text`;
      expect(sanitizeText(input)).toBe('safetext');
    });

    it('strips C1 control characters', () => {
      const input = `text${C1_CSI}more`;
      expect(sanitizeText(input)).toBe('textmore');
    });

    it('strips bidi override (Trojan-Source)', () => {
      const RLO = String.fromCharCode(0x202e);
      const PDF = String.fromCharCode(0x202c);
      const input = `safe ${RLO} EVIL ${PDF} tail`;
      expect(sanitizeText(input)).toBe('safe  EVIL  tail');
    });

    it('strips zero-width and word-joiner code points', () => {
      const ZWSP = String.fromCharCode(0x200b);
      const ZWNJ = String.fromCharCode(0x200c);
      const ZWJ = String.fromCharCode(0x200d);
      const LRM = String.fromCharCode(0x200e);
      const RLM = String.fromCharCode(0x200f);
      const WJ = String.fromCharCode(0x2060);
      const BOM = String.fromCharCode(0xfeff);
      const input = `h${ZWSP}e${ZWNJ}l${ZWJ}l${LRM}o${RLM}${WJ}world${BOM}`;
      expect(sanitizeText(input)).toBe('helloworld');
    });

    it('strips Unicode Tag-block (e.g., U+E0041)', () => {
      const tagA = String.fromCodePoint(0xe0041);
      const tagB = String.fromCodePoint(0xe0042);
      const input = `prefix${tagA}${tagB}suffix`;
      expect(sanitizeText(input)).toBe('prefixsuffix');
    });

    it('handles empty input', () => {
      expect(sanitizeText('')).toBe('');
      expect(sanitizeText(undefined as unknown as string)).toBe('');
      expect(sanitizeText(null as unknown as string)).toBe('');
    });
  });

  describe('stripControl', () => {
    it('strips control chars but keeps tab/LF/CR by default', () => {
      const input = `line1${NUL}\nline2`;
      expect(stripControl(input)).toBe('line1\nline2');
    });

    it('strips all whitespace control when preserveWhitespace=false', () => {
      const input = 'a\nb\tc\r';
      expect(stripControl(input, false)).toBe('abc');
    });
  });

  describe('sanitizeJsonValue', () => {
    it('passes primitives through unchanged', () => {
      expect(sanitizeJsonValue(42)).toBe(42);
      expect(sanitizeJsonValue(true)).toBe(true);
      expect(sanitizeJsonValue(null)).toBe(null);
      expect(sanitizeJsonValue(undefined)).toBe(undefined);
    });

    it('sanitises string values', () => {
      expect(sanitizeJsonValue(`${ESC}[31mhi`)).toBe('hi');
    });

    it('recurses into arrays', () => {
      const input = ['ok', `${ESC}[33mbad`, 'fine'];
      expect(sanitizeJsonValue(input)).toEqual(['ok', 'bad', 'fine']);
    });

    it('recurses into objects + sanitises keys', () => {
      const input = {
        normal: 'value',
        [`field${ESC}[1m`]: 'with-ansi-key',
        nested: { x: `${ESC}[31mred`, y: 7 },
      };
      const out = sanitizeJsonValue(input) as Record<string, unknown>;
      expect(out.normal).toBe('value');
      expect(out.field).toBe('with-ansi-key'); // ESC[1m stripped from key
      expect((out.nested as { x: string; y: number }).x).toBe('red');
      expect((out.nested as { x: string; y: number }).y).toBe(7);
    });

    it('returns Date / Buffer / Map / Set unchanged', () => {
      const d = new Date(0);
      expect(sanitizeJsonValue(d)).toBe(d);
      const m = new Map([['k', 'v']]);
      expect(sanitizeJsonValue(m)).toBe(m);
    });

    it('caps recursion at depth 32', () => {
      type Deep = { next?: Deep; v: string };
      let cur: Deep = { v: `${ESC}[31mx` };
      const root = cur;
      for (let i = 0; i < 50; i += 1) {
        const n: Deep = { v: `${ESC}[31mx` };
        cur.next = n;
        cur = n;
      }
      const sanitised = sanitizeJsonValue(root) as Deep;
      // First level was sanitised
      expect(sanitised.v).toBe('x');
    });
  });
});
