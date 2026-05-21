/**
 * Decoder for app.rwa.xyz's tRPC bulk-query response format.
 *
 * Wire format (reverse-engineered, see development/ORACLE_DATA_MINE/README.md):
 *
 *   base64(
 *     random_15_byte_salt        // appears to be per-response, deterministic for a given input
 *     || gzip(                    // standard RFC 1952 gzip wrapper around DEFLATE
 *       REVERSE(                  // string-level character reversal
 *         JSON.stringify(payload) //
 *       )                         //
 *     )                           //
 *     || optional_trailing_bytes  // sometimes present, ignored by gzip itself
 *                                  // (Node's gunzipSync rejects these — use inflateRaw)
 *   )
 *
 * Endpoints using this format (so far): tokenTimeseries.queryTimeseries,
 * transactions.query, tokenHolders.query, catalog.query. Auth/control
 * endpoints (users.getProfile, analytics.track, search.getInitialSearchGroups)
 * return plain JSON in the normal tRPC envelope.
 *
 * To consume a captured XHR: read the raw response body as JSON, extract the
 * `result.data` string (or `result.data` of element 0 if batched), and pass it
 * to `decodeRwaXyzTrpc`.
 */
import * as zlib from 'node:zlib';

const SALT_BYTES = 15;
const GZIP_HEADER_BYTES = 10; // 1f 8b 08 FLG MTIME(4) XFL OS

/**
 * Decode an rwa.xyz tRPC bulk-query response body string.
 *
 * Throws if the format doesn't match (corrupt response, format changed).
 * Returns the parsed payload (whatever the underlying procedure returned).
 */
export function decodeRwaXyzTrpc(b64Data: string): unknown {
  if (typeof b64Data !== 'string') {
    throw new TypeError('decodeRwaXyzTrpc: expected base64 string');
  }
  const buf = Buffer.from(b64Data, 'base64');
  if (buf.length < SALT_BYTES + GZIP_HEADER_BYTES) {
    throw new Error(
      `decodeRwaXyzTrpc: buffer too short (${buf.length} bytes), need at least ${SALT_BYTES + GZIP_HEADER_BYTES}`,
    );
  }

  const gz = buf.subarray(SALT_BYTES);
  if (gz[0] !== 0x1f || gz[1] !== 0x8b || gz[2] !== 0x08) {
    throw new Error(
      `decodeRwaXyzTrpc: expected gzip magic 1f 8b 08 at offset ${SALT_BYTES}, got ${gz.subarray(0, 3).toString('hex')}`,
    );
  }

  // Skip the 10-byte gzip header. The TRAILER (CRC32+ISIZE) lives at the END
  // of the gzip stream — NOT necessarily at the end of the buffer. Trailing
  // bytes after the gzip stream sometimes appear; inflateRawSync stops at the
  // deflate end-of-stream marker and ignores them. (gunzipSync would try to
  // interpret trailing bytes as the start of another gzip member and fail.)
  const deflate = gz.subarray(GZIP_HEADER_BYTES);
  const decompressed = zlib.inflateRawSync(deflate, {
    finishFlush: zlib.constants.Z_SYNC_FLUSH,
  });

  // The decompressed JSON is character-reversed (simple obfuscation).
  const text = reverseString(decompressed.toString('utf8'));

  return JSON.parse(text);
}

/**
 * Detect whether a tRPC `result.data` value is in the encoded format we know.
 * tRPC responses come in two shapes:
 *   - plain:   { result: { data: <object> } }
 *   - encoded: { result: { data: "<base64 starting with non-readable chars>" } }
 * Batched endpoints wrap responses in an outer array.
 */
export function isEncodedTrpcData(data: unknown): data is string {
  if (typeof data !== 'string') return false;
  if (data.length < 32) return false;
  // Strong heuristic: decode the first 20 chars; if bytes 15-16 are 1f 8b, it's our format.
  try {
    const buf = Buffer.from(data.slice(0, 32), 'base64');
    return buf.length > 17 && buf[15] === 0x1f && buf[16] === 0x8b;
  } catch {
    return false;
  }
}

/**
 * Read the `result.data` field out of a tRPC response body, transparently
 * handling both batched ([{result:...}]) and unbatched ({result:...}) envelopes.
 * Returns the raw `data` value — could be a plain object OR an encoded string.
 * Use `isEncodedTrpcData` + `decodeRwaXyzTrpc` to peel it open if needed.
 */
export function extractTrpcData(responseJson: unknown): unknown {
  const env = Array.isArray(responseJson) ? responseJson[0] : responseJson;
  const e = env as { result?: { data?: unknown }; error?: unknown };
  if (e?.error) {
    throw new Error(
      `tRPC error: ${JSON.stringify(e.error).slice(0, 200)}`,
    );
  }
  return e?.result?.data;
}

function reverseString(s: string): string {
  // Note: this is a *character* reverse (Array.from handles surrogate pairs
  // for emoji/4-byte unicode). rwa.xyz's payloads are ASCII-heavy JSON, so
  // even a naive split('').reverse().join('') works, but be safe.
  return Array.from(s).reverse().join('');
}
