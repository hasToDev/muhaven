/**
 * Wave 4 P8 — output sanitizer (ANSI + control + Unicode-smuggling).
 *
 * Used in two places:
 *
 *   1. **Input side** (PromptArmor): clean what the LLM sees so smuggling
 *      attacks (e.g., U+202E right-to-left override) cannot deliver
 *      instructions invisible to the operator's audit log.
 *   2. **Output side** (ToolDispatcher / ChatLlmService.sink): clean
 *      structured tool results before they hit the SSE wire and the
 *      browser-side terminal-rendering surfaces. ANSI in a tool result
 *      can rewrite the chat history visually (Trail-of-Bits 2024 finding).
 *
 * No allocation hot path: `sanitizeText` short-circuits on the no-violation
 * case via a single regex test before falling back to a per-char rewrite.
 */

const ESC = '';

// Code points that may be present in legitimate text. Whitelisted so a
// pure-ASCII message does not lose its newlines / tabs.
const PRESERVED_CONTROL_CODES = new Set<number>([0x09, 0x0a, 0x0d]); // tab, LF, CR

/**
 * Patterns to strip:
 *   - ANSI CSI sequences:   ESC `[` (params) (final byte 0x40-0x7e)
 *   - ANSI OSC sequences:   ESC `]` ... BEL or ESC `\`
 *   - Other ESC sequences:  ESC + single byte in 0x40-0x5f (Fe family) other
 *                           than `[` and `]` (already handled above)
 *   - C0 control chars (except TAB / LF / CR / DEL):  U+0000 .. U+001F
 *   - DEL:                  U+007F
 *   - C1 control chars:     U+0080 .. U+009F
 *   - Bidi overrides:       U+202A..U+202E + U+2066..U+2069
 *   - Zero-width / formatting: U+200B..U+200F + U+2060..U+2064 + U+FEFF
 *
 * Tag Block (U+E0000..U+E007F, supplementary-plane) is handled by a
 * surrogate-aware sweep below since the `u`-flag regex range syntax is
 * fiddly across Node + tsx.
 */
const STRIP_PATTERN = new RegExp(
  [
    `${ESC}\\[[0-?]*[ -/]*[@-~]`,
    `${ESC}\\][\\s\\S]*?(?:\\u0007|${ESC}\\\\)`,
    `${ESC}[@A-Z\\\\^_]`,
    '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]',
    '[\\u0080-\\u009F]',
    '[\\u200B-\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]',
  ].join('|'),
  'gu',
);

/**
 * Strip ANSI escapes, control characters, bidi overrides, zero-width
 * characters, and Unicode Tag-block code points from the input. The
 * sanitized text is always a subset of the original.
 */
export function sanitizeText(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return '';

  // Fast path: if no escape / control / smuggling code-point appears, the
  // input is already clean. We rebuild the regex below since the global
  // flag carries lastIndex state across invocations.
  STRIP_PATTERN.lastIndex = 0;
  const dirty = STRIP_PATTERN.test(input) || hasTagBlock(input);
  if (!dirty) return input;
  STRIP_PATTERN.lastIndex = 0;

  let result = input.replace(STRIP_PATTERN, '');
  if (hasTagBlock(result)) result = stripTagBlock(result);
  return result;
}

function hasTagBlock(s: string): boolean {
  for (let i = 0; i < s.length;) {
    const cp = s.codePointAt(i);
    if (cp === undefined) {
      i += 1;
      continue;
    }
    if (cp >= 0xe0000 && cp <= 0xe007f) return true;
    i += cp > 0xffff ? 2 : 1;
  }
  return false;
}

function stripTagBlock(s: string): string {
  const out: string[] = [];
  for (let i = 0; i < s.length;) {
    const cp = s.codePointAt(i);
    if (cp === undefined) {
      i += 1;
      continue;
    }
    const isTag = cp >= 0xe0000 && cp <= 0xe007f;
    if (!isTag) out.push(String.fromCodePoint(cp));
    i += cp > 0xffff ? 2 : 1;
  }
  return out.join('');
}

/**
 * Strip control characters from a string, optionally preserving newlines /
 * tabs. Unlike `sanitizeText`, this is a narrow pass used by callers who
 * need finer-grained control (e.g., the test corpus's expected output).
 */
export function stripControl(input: string, preserveWhitespace = true): string {
  if (typeof input !== 'string') return '';
  let out = '';
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) {
      if (preserveWhitespace && PRESERVED_CONTROL_CODES.has(cp)) out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Recursively sanitize every string in a JSON-shaped value. Used by the
 * tool-dispatcher to scrub tool results before the LLM (or the SSE
 * stream) sees them. Numbers / booleans / null pass through untouched;
 * arrays + plain objects recurse; class instances are converted to plain
 * objects via Object.entries to drop prototype-bound state.
 */
export function sanitizeJsonValue<T>(value: T, depth = 0): T {
  if (depth > 32) return value; // defensive cap
  if (value == null) return value;
  if (typeof value === 'string') return sanitizeText(value) as unknown as T;
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((v) => sanitizeJsonValue(v, depth + 1)) as unknown as T;
  }

  // bigint / Date / Map / Set / Buffer pass through unchanged — the chat
  // surface always serialises with JSON.stringify which rejects bigint
  // anyway, and tool DTOs use plain objects + strings.
  if (
    value instanceof Date
    || value instanceof Map
    || value instanceof Set
    || (typeof Buffer !== 'undefined' && Buffer.isBuffer(value))
  ) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[sanitizeText(k)] = sanitizeJsonValue(v, depth + 1);
  }
  return out as unknown as T;
}
