/**
 * Tests for the icon validation surface. Pure helpers → fast, no IO.
 * Run: `npm run test:icons` (from scripts/oracle-mine) or
 *      `tsx --test scripts/lib/icon-validate.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSafeTicker,
  sniffImageType,
  checkIconUrl,
  validateIconBytes,
  readBodyCapped,
  EXT_BY_TYPE,
  DEFAULT_MAX_ICON_BYTES,
  type CappableResponse,
} from './icon-validate.ts';

// ── Magic-byte signatures (minimal valid headers) ───────────────────────
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF87 = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x01, 0x00]);
const GIF89 = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
// "RIFF" + 4 size bytes + "WEBP"
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
const SVG = new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>');
const HTML = new TextEncoder().encode('<!DOCTYPE html><html></html>');

test('sniffImageType detects each allowed raster format', () => {
  assert.equal(sniffImageType(PNG), 'png');
  assert.equal(sniffImageType(JPEG), 'jpeg');
  assert.equal(sniffImageType(GIF87), 'gif');
  assert.equal(sniffImageType(GIF89), 'gif');
  assert.equal(sniffImageType(WEBP), 'webp');
});

test('sniffImageType rejects SVG and non-image bytes', () => {
  assert.equal(sniffImageType(SVG), null);
  assert.equal(sniffImageType(HTML), null);
  assert.equal(sniffImageType(new Uint8Array(0)), null);
});

test('sniffImageType rejects truncated and malformed headers', () => {
  assert.equal(sniffImageType(PNG.subarray(0, 4)), null, 'truncated PNG');
  // RIFF container that is NOT WebP (e.g. WAV) must not pass as webp.
  const RIFF_WAV = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]);
  assert.equal(sniffImageType(RIFF_WAV), null);
  // GIF prefix with a bad version byte.
  const GIF_BAD = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x35, 0x61, 0x01, 0x00]);
  assert.equal(sniffImageType(GIF_BAD), null);
});

test('EXT_BY_TYPE maps jpeg to .jpg', () => {
  assert.equal(EXT_BY_TYPE.jpeg, 'jpg');
  assert.equal(EXT_BY_TYPE.png, 'png');
  assert.equal(EXT_BY_TYPE.webp, 'webp');
  assert.equal(EXT_BY_TYPE.gif, 'gif');
});

test('isSafeTicker accepts the rwa.xyz ticker shapes', () => {
  for (const t of ['USYC', 'BUIDL', 'syrupUSDC', 'MUon', 'NVDAon', 'STRCx', 'TSLA-x', 'cetes_1']) {
    assert.equal(isSafeTicker(t), true, t);
  }
});

test('isSafeTicker rejects traversal / unsafe filename inputs', () => {
  for (const t of ['../etc', 'a/b', 'a.b', 'a b', '', 'a'.repeat(33), '..', 'a\\b', 'a ', 'a%2e']) {
    assert.equal(isSafeTicker(t), false, JSON.stringify(t));
  }
});

test('checkIconUrl accepts https, rejects non-https by default', () => {
  assert.equal(checkIconUrl('https://img.rwa.xyz/x.png').ok, true);
  const http = checkIconUrl('http://img.rwa.xyz/x.png');
  assert.equal(http.ok, false);
  // Opt-in http.
  assert.equal(checkIconUrl('http://img.rwa.xyz/x.png', { allowHttp: true }).ok, true);
});

test('checkIconUrl rejects non-web schemes', () => {
  assert.equal(checkIconUrl('data:image/png;base64,AAAA').ok, false);
  assert.equal(checkIconUrl('ftp://host/x.png').ok, false);
  assert.equal(checkIconUrl('file:///etc/passwd').ok, false);
  assert.equal(checkIconUrl('not a url').ok, false);
});

test('checkIconUrl blocks loopback / private / link-local hosts (SSRF guard)', () => {
  const blocked = [
    'https://localhost/x.png',
    'https://app.localhost/x.png',
    'https://service.internal/x.png',
    'https://db.local/x.png',
    'https://127.0.0.1/x.png',
    'https://10.0.0.5/x.png',
    'https://192.168.1.10/x.png',
    'https://172.16.0.1/x.png',
    'https://172.31.255.255/x.png',
    'https://169.254.169.254/latest/meta-data', // cloud metadata
    'https://0.0.0.0/x.png',
    'https://[::1]/x.png',
  ];
  for (const u of blocked) {
    assert.equal(checkIconUrl(u).ok, false, u);
  }
});

test('checkIconUrl blocks IPv4-mapped IPv6 and IPv6 private/link-local', () => {
  const blocked = [
    'https://[::ffff:169.254.169.254]/meta', // mapped metadata (dotted)
    'https://[::ffff:127.0.0.1]/x', // mapped loopback (dotted)
    'https://[::ffff:10.0.0.1]/x', // mapped private (dotted)
    'https://[::ffff:a9fe:a9fe]/meta', // mapped metadata (hex — WHATWG canonical form)
    'https://[::ffff:7f00:1]/x', // mapped loopback (hex)
    'https://[fd00::1]/x', // IPv6 unique-local (fc00::/7)
    'https://[fe80::1]/x', // IPv6 link-local (fe80::/10)
  ];
  for (const u of blocked) {
    assert.equal(checkIconUrl(u).ok, false, u);
  }
});

test('checkIconUrl allows routable public IPs (v4 + v6) and the 172 non-private band', () => {
  assert.equal(checkIconUrl('https://8.8.8.8/x.png').ok, true);
  assert.equal(checkIconUrl('https://172.15.0.1/x.png').ok, true, '172.15 is public');
  assert.equal(checkIconUrl('https://172.32.0.1/x.png').ok, true, '172.32 is public');
  assert.equal(checkIconUrl('https://[2606:4700::1111]/x.png').ok, true, 'public IPv6');
});

test('validateIconBytes enforces size cap and sniff', () => {
  const okPng = validateIconBytes(PNG);
  assert.equal(okPng.ok, true);
  if (okPng.ok) {
    assert.equal(okPng.type, 'png');
    assert.equal(okPng.ext, 'png');
  }
  assert.equal(validateIconBytes(new Uint8Array(0)).ok, false, 'empty');
  assert.equal(validateIconBytes(SVG).ok, false, 'svg');
  // Oversized: a buffer with a valid PNG header but past the cap.
  const huge = new Uint8Array(DEFAULT_MAX_ICON_BYTES + 1);
  huge.set(PNG.subarray(0, 8), 0);
  assert.equal(validateIconBytes(huge).ok, false, 'oversized');
  // Custom cap.
  assert.equal(validateIconBytes(PNG, { maxBytes: 4 }).ok, false, 'tiny cap');
});

// ── readBodyCapped (streamed size cap) ──────────────────────────────────
function streamResponse(chunks: Uint8Array[]): CappableResponse {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    }),
    async arrayBuffer() {
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      return out.buffer;
    },
  };
}

function bodylessResponse(bytes: Uint8Array): CappableResponse {
  return { body: null, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

test('readBodyCapped concatenates multi-chunk bodies under the cap', async () => {
  const res = streamResponse([Uint8Array.from([1, 2, 3]), Uint8Array.from([4, 5]), Uint8Array.from([6])]);
  const r = await readBodyCapped(res, 100);
  assert.ok('bytes' in r);
  if ('bytes' in r) assert.deepEqual([...r.bytes], [1, 2, 3, 4, 5, 6]);
});

test('readBodyCapped cancels mid-stream when a later chunk crosses the cap', async () => {
  // 3 + 3 = 6 bytes; cap 4 → must reject (and the cancel must not throw).
  const res = streamResponse([new Uint8Array(3), new Uint8Array(3)]);
  const r = await readBodyCapped(res, 4);
  assert.ok('tooLarge' in r);
});

test('readBodyCapped accepts a body exactly at the cap, rejects one over', async () => {
  assert.ok('bytes' in (await readBodyCapped(streamResponse([new Uint8Array(8)]), 8)));
  assert.ok('tooLarge' in (await readBodyCapped(streamResponse([new Uint8Array(9)]), 8)));
});

test('readBodyCapped falls back to arrayBuffer when there is no stream', async () => {
  const ok = await readBodyCapped(bodylessResponse(Uint8Array.from([1, 2, 3])), 10);
  assert.ok('bytes' in ok);
  const over = await readBodyCapped(bodylessResponse(new Uint8Array(20)), 8);
  assert.ok('tooLarge' in over);
});
