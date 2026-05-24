/**
 * Pure validation helpers for the marketplace icon self-host pipeline
 * (`fetch-icons.ts`).
 *
 * Wave 5 — fix broken marketplace token icons. The SPA is served with
 * `Cross-Origin-Embedder-Policy: require-corp` (load-bearing for the FHE
 * WASM's `SharedArrayBuffer`), which blocks third-party rwa.xyz S3 icons.
 * The fix bakes each token's icon into the frontend bundle so they're
 * served same-origin. `fetch-icons.ts` downloads the bytes; THIS module
 * is the dependency-free, unit-tested validation surface those bytes
 * pass through before they're written to disk.
 *
 * No IO, no Node-only APIs beyond the WHATWG `URL` — every function is a
 * pure predicate so the security controls (magic-byte sniff, content-type
 * allowlist, SVG rejection, ticker path-safety, SSRF host guard) have
 * fast, durable `node:test` coverage. See `icon-validate.test.ts`.
 */

/** Image formats we will bake. SVG is deliberately excluded — it can
 * carry script, and serving attacker-influenced markup from our own
 * origin is a needless risk. `<img>` won't execute SVG script, but the
 * rwa.xyz icons observed are all raster (.png/.jpg). */
export type AllowedImageType = 'png' | 'jpeg' | 'webp' | 'gif';

/** File extension written to disk per sniffed type. JPEG → `.jpg`. */
export const EXT_BY_TYPE: Readonly<Record<AllowedImageType, string>> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
  gif: 'gif',
};

/** Hard cap on a single baked icon. The legitimate rwa.xyz CDN icons are
 * 3.5–32 KB; 512 KB leaves generous headroom while rejecting degenerate
 * multi-MB raw uploads (e.g. CETES's source S3 object is ~5.7 MB — see
 * the override in `fetch-icons.ts`). Bytes this large have no business in
 * a 40 px card icon and would bloat the static bundle. */
export const DEFAULT_MAX_ICON_BYTES = 512 * 1024;

// Tickers become filenames on disk (`<TICKER>.<ext>`) AND path segments
// in the served URL, so they must not carry `/`, `.`, whitespace, or any
// traversal sequence. Mirrors the backend ingest schema
// (oracle-ingest.dto.ts `tickerSchema`): `[A-Za-z0-9_-]{1,32}`.
const TICKER_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** True when `ticker` is safe to use as a filename + URL path segment. */
export function isSafeTicker(ticker: string): boolean {
  return TICKER_RE.test(ticker);
}

/**
 * Detect the image format from the leading magic bytes. Returns null for
 * anything not in the raster allowlist (notably SVG, which is text and
 * has no binary signature). Never trusts the declared `Content-Type` or
 * the URL extension — the bytes are authoritative.
 */
export function sniffImageType(bytes: Uint8Array): AllowedImageType | null {
  // PNG — 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  // JPEG — FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  // GIF — "GIF87a" / "GIF89a"
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'gif';
  }
  // WebP — "RIFF" .... "WEBP" (tag at offset 8)
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * SSRF guard for the icon source URL. This tool runs on the operator's
 * trusted machine (not the backend — that's the whole point of doing the
 * download "scraper-side"), so the threat is narrow: a poisoned scrape /
 * compromised oracle row pointing the fetch at an internal address (e.g.
 * the cloud metadata endpoint). Defense-in-depth: require https and
 * refuse literal loopback / private / link-local hosts.
 *
 * Note: this is a string/literal-IP check, not DNS resolution — a
 * hostname that resolves to a private IP is not caught. That's an
 * accepted limitation for an operator-run CLI fetching known public CDN
 * URLs; it stops the literal-IP class (incl. the cloud metadata endpoint
 * and its IPv4-mapped-IPv6 spelling). `fetch-icons.ts` additionally
 * re-validates the FINAL url after redirects so a 30x to an internal host
 * can't slip past this pre-fetch check.
 */
export function checkIconUrl(raw: string, opts: { allowHttp?: boolean } = {}): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (url.protocol !== 'https:' && !(opts.allowHttp && url.protocol === 'http:')) {
    return { ok: false, reason: `disallowed protocol "${url.protocol}" (https required)` };
  }
  // WHATWG `URL.hostname` keeps the brackets on IPv6 literals (`[::1]`);
  // strip them so the loopback/unspecified checks below match.
  const host = url.hostname.toLowerCase().replace(/^\[(.+)\]$/, '$1');
  if (isBlockedHost(host)) {
    return { ok: false, reason: `blocked host "${host}" (loopback/private/link-local)` };
  }
  return { ok: true, url };
}

function isBlockedHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  // IPv6 loopback / unspecified.
  if (host === '::1') return true;
  if (host === '::') return true;
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]?:/.test(host)) return true;
  // IPv4-mapped IPv6 — unwrap the embedded v4 and re-check. WHATWG `URL`
  // normalizes `::ffff:169.254.169.254` to the hex form `::ffff:a9fe:a9fe`,
  // but accept a dotted tail too for robustness.
  const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isBlockedV4((hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff);
  }
  const mappedDot = host.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (mappedDot) {
    return isBlockedV4(Number(mappedDot[1]), Number(mappedDot[2]), Number(mappedDot[3]), Number(mappedDot[4]));
  }
  // IPv4 literal — block loopback / this-host / private / link-local.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    return isBlockedV4(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]));
  }
  return false;
}

function isBlockedV4(a: number, b: number, _c: number, _d: number): boolean {
  if (a === 0) return true; // 0.0.0.0/8 — "this host"
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private class A
  if (a === 169 && b === 254) return true; // link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private class B
  if (a === 192 && b === 168) return true; // private class C
  return false;
}

export type IconValidation =
  | { ok: true; type: AllowedImageType; ext: string }
  | { ok: false; reason: string };

/**
 * Full byte-level validation: size cap + magic-byte sniff. Combines the
 * two checks `fetch-icons.ts` runs after a download so the verdict (and
 * its rejection reasons) are testable in one place.
 */
export function validateIconBytes(
  bytes: Uint8Array,
  opts: { maxBytes?: number } = {},
): IconValidation {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_ICON_BYTES;
  if (bytes.length === 0) {
    return { ok: false, reason: 'empty response body' };
  }
  if (bytes.length > maxBytes) {
    return { ok: false, reason: `too large: ${bytes.length} bytes > cap ${maxBytes}` };
  }
  const type = sniffImageType(bytes);
  if (!type) {
    return { ok: false, reason: 'unrecognized image bytes (not png/jpeg/webp/gif; SVG rejected)' };
  }
  return { ok: true, type, ext: EXT_BY_TYPE[type] };
}

export type ReadResult = { bytes: Uint8Array } | { tooLarge: true };

/** Minimal structural view of the parts of a `fetch` `Response` that
 * `readBodyCapped` touches — keeps the helper trivially fakeable in tests. */
export interface CappableResponse {
  body: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Read a response body, cancelling the stream the instant it exceeds the
 * cap so a hostile/huge source can't exhaust memory before the size check
 * runs. Falls back to `arrayBuffer()` (with a post-read length check) only
 * when the response exposes no readable stream.
 */
export async function readBodyCapped(
  res: CappableResponse,
  maxBytes: number,
): Promise<ReadResult> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.length > maxBytes ? { tooLarge: true } : { bytes: buf };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  return { bytes: merged };
}
