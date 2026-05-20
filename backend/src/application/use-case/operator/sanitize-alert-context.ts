import type { OperatorAlertPayload } from '../../../infrastructure/operator/operator-alert-transport.js';

/**
 * Wave 5 Q3 (step 3, plan C.3) — pure sanitiser for operator-alert
 * context strings.
 *
 * The cron's catch hands an arbitrary `unknown` (the thrown error) +
 * token-side context here; this function returns a minimal,
 * non-leaking `OperatorAlertPayload` ready for the transport. Five
 * concrete guarantees:
 *
 *   1. Field whitelist — only `err.name`, `err.shortMessage ?? err.
 *      message ?? err.name` are read. We never touch `err.cause`,
 *      `err.data`, `err.metaMessages`, `err.stack`. ethers / viem
 *      revert errors tend to carry encrypted handles and base64 input
 *      blobs in `data`/`metaMessages`; a verbatim `JSON.stringify(err)`
 *      would forward those to Telegram. The whitelist defeats that
 *      class of leak by construction.
 *
 *   2. Three-pass regex redaction (order pinned per v3.1 plan S1):
 *      (a) `0x` + 64 hex chars       → tx hash / FHE handle → `0x…tx`
 *      (b) `0x` + 40 hex chars       → EVM address; preserves the
 *                                     known token address if it
 *                                     matches (operator scans alerts
 *                                     by symbol AND address); every
 *                                     other 40-hex string → `0x…addr`
 *      (c) base64-ish opaque blobs   → `[A-Za-z0-9+/]{40,}={0,2}`     →
 *                                     `[…opaque]`. Catches cofhe
 *                                     ciphertext + JWT-shaped strings.
 *
 *      Order matters: 64-hex first (always redact, no exceptions) so a
 *      40-hex *prefix* of a 64-hex string doesn't get matched first by
 *      the address pass and leave the suffix exposed. The base64 pass
 *      runs last because it's the most permissive — running it earlier
 *      would over-redact hex content that the address pass would have
 *      preserved.
 *
 *   3. Length caps — `errorClass ≤ 64`, `shortMessage ≤ 1024`. Cuts at
 *      the BOUNDARY, never silently expands. Telegram per-message cap is
 *      4096; after the bot's MarkdownV2 escape pass the on-wire string
 *      can grow up to ~2× — 1024 raw + ~50 chars header = safely under.
 *
 *   4. Severity defaults to `'error'`. The cron is the only caller
 *      today; every alert it fires is by definition an error condition
 *      (no-holders + dry-run paths short-circuit BEFORE the catch). A
 *      future caller wanting info/warn can override via `severity` on
 *      the input.
 *
 *   5. Pure function — no DB, no logger, no I/O. The cron's catch can
 *      invoke this synchronously; testability + future "send via N
 *      transports in parallel" composition are both straightforward.
 *
 * Why this isn't on the runner: the runner is intentionally I/O-free
 * (it just throws six distinct error classes — see
 * `yield-epoch-runner.ts:251-330`). The cron's catch is the layer that
 * has both the operator-chat-id wiring AND the symbol/epoch context,
 * so it owns the sanitiser invocation.
 */

export interface SanitizeAlertInput {
  err: unknown;
  tokenSymbol: string;
  /** Lower-case EVM address; if a known address shows up in the error
   *  message it's preserved verbatim instead of redacted. Optional —
   *  callers that don't have the address pass undefined and ALL 40-hex
   *  strings get redacted, which is the safe default. */
  tokenAddress?: string;
  epochId?: bigint;
  /** Defaults to `'error'`. */
  severity?: OperatorAlertPayload['severity'];
}

// Round-2 Reality H-1: anchor both hex regexes to defeat trailing-hex
// leakage. The earlier `0x[a-fA-F0-9]{64}` matched the first 66 chars
// of `0x` + 100 hex and left 36 hex chars unredacted; the earlier
// `0x[a-fA-F0-9]{40}` matched the first 42 chars of `0x` + 50 hex and
// left 10 hex chars unredacted. Both classes of leak now closed by:
//   - TX pass: greedy `{64,}` floor — collapses any 64+ hex run into a
//     single `0x…tx` (no trailing hex possible).
//   - Address pass: exact `{40}` + negative lookahead `(?![a-fA-F0-9])`
//     — refuses to match when a 41st hex char follows; the dangerous
//     range `0x[41-63 hex]` falls through to the base64 pass which
//     catches it via `[A-Za-z0-9+/]{40,}` (hex is a subset).
const TX_HASH_RE = /0x[a-fA-F0-9]{64,}/g;
const ADDRESS_RE = /0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/g;
// Base64-ish opaque blob. The `{40,}` floor avoids redacting short hex
// suffixes (e.g. a 16-char error code in a sanitiser test fixture).
// Bracket class is the canonical base64 set [A-Za-z0-9+/] + optional
// trailing `=` padding (≤ 2). Many cofhe ciphertext blobs include both
// digits + letters so the regex matches; a pure-ASCII English word of
// 40+ chars would too, but English error messages don't tend to have
// 40-char unbroken words.
const BASE64_BLOB_RE = /[A-Za-z0-9+/]{40,}={0,2}/g;

const ERROR_CLASS_MAX = 64;
const SHORT_MESSAGE_MAX = 1024;

// Sentinel chosen for two properties:
//   - Round-1 review (Code Reviewer HIGH + Security H-1): an earlier
//     impl used `__ADDR_PRESERVED_<n>__` as the sentinel, which (a) is
//     reachable as user-input text in error messages, letting an
//     attacker inject the literal and trigger a swap with the real
//     known address; (b) `replace(literalString, …)` only substitutes
//     the FIRST occurrence, so duplicate placeholders surfaced through
//     normal input keep the placeholder forever.
//   - Fix: wrap the index with `` (control char, not in any
//     base64 / hex / printable ASCII), use `replaceAll` for restoration,
//     AND reject any input that contains `` at the top of the
//     function. `` cannot survive a JSON-encoded error message,
//     a stringified ethers RevertError, or any normal cron failure
//     path; if it shows up we treat it as a hostile or corrupted input
//     and short-circuit to a safe default.
const SENTINEL_CHAR = '';
const SENTINEL_PREFIX = `${SENTINEL_CHAR}A`;
const SENTINEL_SUFFIX = `Z${SENTINEL_CHAR}`;

function makeSentinel(idx: number): string {
  return `${SENTINEL_PREFIX}${idx}${SENTINEL_SUFFIX}`;
}

export function sanitizeAlertContext(input: SanitizeAlertInput): OperatorAlertPayload {
  const errAny = input.err as { name?: unknown; shortMessage?: unknown; message?: unknown };
  // String() coerces anything ending up here — Symbol included — to a
  // bounded string. The whitelist below means we don't reach into
  // `cause` / `data` / `metaMessages` even if they exist.
  const rawErrorClass =
    typeof errAny?.name === 'string' && errAny.name.length > 0
      ? errAny.name
      : 'UnknownError';
  const rawMessage =
    typeof errAny?.shortMessage === 'string' && errAny.shortMessage.length > 0
      ? errAny.shortMessage
      : typeof errAny?.message === 'string' && errAny.message.length > 0
        ? errAny.message
        : typeof errAny?.name === 'string' && errAny.name.length > 0
          ? errAny.name
          : 'unknown';

  const errorClass = rawErrorClass.slice(0, ERROR_CLASS_MAX);

  // Round-1 hostile-input defence: any `` in the input means
  // either a corrupted upstream pipeline OR an attacker probing the
  // sentinel substitution. Don't try to be clever — strip + audit later.
  const presanitisedMessage = rawMessage.includes(SENTINEL_CHAR)
    ? rawMessage.split(SENTINEL_CHAR).join('')
    : rawMessage;

  const tokenAddressLower = input.tokenAddress?.toLowerCase();

  // 1) tx-hash / FHE handle (64 hex) — always redact.
  let redacted = presanitisedMessage.replace(TX_HASH_RE, '0x…tx');

  // 2) EVM address (40 hex) — preserve known token address (always as
  //    the CANONICAL form the caller supplied), redact everything else.
  //
  //    Round-2 Reality M-3: an earlier impl preserved the attacker's
  //    case-shape from the input. A wrong-checksum form of the right
  //    address is a phishing primitive — operator pastes the
  //    "preserved" address into Etherscan, auto-checksum-corrects, and
  //    lands on a DIFFERENT address. We now emit the caller-supplied
  //    `input.tokenAddress` for every preserved occurrence, regardless
  //    of the case-shape the message had.
  //
  //    Subtle correctness issue: the hex chars of a preserved address
  //    are a subset of the base64 alphabet `[A-Za-z0-9+/]`, so pass 3
  //    would re-collapse a preserved 40-hex address into `[…opaque]`.
  //    Defeated by swapping each preserved match out for a control-
  //    char-bracketed sentinel (NOT in the base64 alphabet) so pass 3's
  //    `{40,}` contiguous-run check terminates at the sentinel
  //    boundary; we restore the canonical form AFTER pass 3 with
  //    `replaceAll` (NOT `replace`, which is first-match-only).
  const preservedAddresses: string[] = [];
  const canonicalAddress = input.tokenAddress;
  redacted = redacted.replace(ADDRESS_RE, (match) => {
    if (tokenAddressLower && match.toLowerCase() === tokenAddressLower) {
      const idx = preservedAddresses.length;
      // Always emit the canonical caller-supplied form, NEVER the
      // attacker's case-shape (Reality M-3).
      preservedAddresses.push(canonicalAddress!);
      return makeSentinel(idx);
    }
    return '0x…addr';
  });

  // 3) Base64-ish opaque blob — final pass. Catches anything the first
  //    two passes didn't already neutralise (cofhe ciphertext, JWTs).
  redacted = redacted.replace(BASE64_BLOB_RE, '[…opaque]');

  // Restoration + length cap interaction (Security H-2): restoration
  // expands each sentinel back to a 42-char address. A naive
  // `.slice(0, MAX)` after restoration could land mid-address and leak
  // a partial 39-hex prefix. We protect against that by (a) restoring
  // first to get the visible-length form, then (b) slicing at MAX with
  // surrogate-pair safety, then (c) trimming back any tail that looks
  // like a partial `0x[hex]+`.
  for (let i = 0; i < preservedAddresses.length; i++) {
    redacted = redacted.replaceAll(makeSentinel(i), preservedAddresses[i]!);
  }

  const shortMessage = capShortMessage(redacted);

  return {
    tokenSymbol: input.tokenSymbol,
    ...(input.epochId !== undefined ? { epochId: input.epochId } : {}),
    errorClass,
    shortMessage,
    severity: input.severity ?? 'error',
  };
}

/**
 * Cut a redacted message down to `SHORT_MESSAGE_MAX` with two safety
 * passes:
 *
 *   1. UTF-16 surrogate safety (Code Reviewer MED) — `.slice` operates
 *      on code units, not code points. A character outside the BMP
 *      (e.g. an emoji or mathematical alphanumeric) is encoded as a
 *      surrogate pair; if the cut lands BETWEEN the two halves the
 *      result is a lone high surrogate. `JSON.stringify` then emits a
 *      bare `\uD800-\uDFFF` escape; Telegram receives mojibake. Detect
 *      a lone high surrogate at the boundary and step back by one.
 *
 *   2. Partial-address safety (Security H-2) — restoration can place a
 *      42-char `0x[hex]{40}` at any offset; if the cut lands inside,
 *      the operator sees `0x` + 1–39 hex chars, which is a valid
 *      address PREFIX an attacker could index against. Walk back the
 *      tail to before the `0x` so the cut never reveals a partial
 *      address.
 *
 * Both passes only fire when the slice actually happened (i.e., the
 * input exceeded the cap); short inputs pass through verbatim.
 */
function capShortMessage(text: string): string {
  if (text.length <= SHORT_MESSAGE_MAX) return text;
  let out = text.slice(0, SHORT_MESSAGE_MAX);

  // Surrogate-pair safety.
  const lastCode = out.charCodeAt(out.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    out = out.slice(0, out.length - 1);
  }

  // Partial-address safety. The longest possible address tail is
  // `0x` + 39 hex = 41 chars (since 40 hex is the full address and
  // already passed the cut). The regex matches a trailing partial
  // address anchored at end-of-string.
  const partial = out.match(/0x[a-fA-F0-9]{1,39}$/);
  if (partial) {
    out = out.slice(0, out.length - partial[0].length);
  }

  return out;
}
