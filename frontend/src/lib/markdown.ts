/**
 * Safe Markdown renderer for LLM-emitted agent chat copy.
 *
 * The agent's Gemini-driven replies sometimes contain Markdown
 * (bold, lists, inline code, links) and the chat surface used to
 * render them via `{{ msg.text }}` which HTML-escapes everything.
 * Surfaced 2026-05-22: operator saw literal `**bold**` and `- list`
 * markers in chat. This module renders LLM output to safe HTML via
 * `marked` → `DOMPurify`. The `v-html` binding in AgentPage.vue
 * mounts the output.
 *
 * Trust posture: LLM output is UNTRUSTED. Two layers of defense:
 *   1. Marked's `breaks: true, gfm: true` mode renders a constrained
 *      subset (no raw HTML by default — marked escapes `<`/`>` inside
 *      text nodes unless they're recognised markdown syntax).
 *   2. DOMPurify sanitises the marked output, stripping any HTML the
 *      LLM might smuggle through (e.g. `<script>`, `<img onerror>`,
 *      `javascript:` URIs, event handlers). The allowlist is
 *      restricted to inline + block formatting tags + safe link
 *      attributes; everything else is dropped.
 *
 * The user-side messages (`msg.role === 'user'`) are still rendered
 * via plain text interpolation in the template — never through this
 * function. If a user pastes markdown into their own prompt, the
 * intent is to display it literally to themselves, not to render.
 *
 * Streaming (Thread 10 polish bundle, 2026-05-23): `renderMarkdownStreaming`
 * splits an in-flight reply into a stable prefix (rendered as markdown,
 * cached so v-html string-identity holds across SSE deltas → keyboard
 * focus on prior anchors survives) and an inflight suffix (rendered as
 * plain text via template interpolation → no mid-stream `<pre>`
 * snap-back when an unclosed code fence is mid-flight). The stable
 * boundary advances on `\n\n` (paragraph break outside a fence) and on
 * closing fence + `\n\n`. Inside-fence `\n\n` does NOT advance the
 * boundary — code blocks stream as a single atomic unit.
 */

import { marked } from 'marked'
import DOMPurify from 'dompurify'

// Render `\n` as `<br>` so multi-line LLM replies preserve their
// visual breaks; enable GitHub-flavored markdown (tables, task lists,
// strikethrough) since the LLM tends to emit those.
//
// Round-2 review AA-H2 (heading-outline pollution): override the
// heading renderer so LLM-emitted `# Heading` → `<h1>Heading</h1>`
// becomes `<p><strong>Heading</strong></p>` instead. The chat surface
// doesn't need a document outline, and SR users navigating by heading
// shouldn't land mid-conversation. Visual emphasis preserved via
// <strong>. The `h1`-`h6` tags are also dropped from ALLOWED_TAGS
// below as defense-in-depth (so a future renderer that bypasses this
// hook still can't emit real h-tags).
marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    heading({ tokens }) {
      // `this.parser` is the marked Parser instance bound at render
      // time. `parseInline` runs the inline pipeline on the heading's
      // child tokens (so `**bold inside** heading` still bolds).
      const inner = (this as unknown as { parser: { parseInline: (t: unknown[]) => string } })
        .parser.parseInline(tokens)
      return `<p><strong>${inner}</strong></p>\n`
    },
  },
})

/**
 * Allowlist: inline formatting + lists + tables + code + headings +
 * blockquotes + links. NO `<script>`, NO `<iframe>`, NO event
 * handlers, NO `<style>`, NO `<form>`. Links get `target="_blank"
 * rel="noopener noreferrer"` enforced via the afterSanitizeAttributes
 * hook below.
 */
const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'strong', 'em', 'del', 's', 'u',
    'ul', 'ol', 'li',
    'code', 'pre',
    'blockquote',
    // `h1`-`h6` intentionally NOT in the allowlist (round-2 review
    // AA-H2). Marked's heading renderer is overridden above to emit
    // `<p><strong>` instead. Defense-in-depth: even if the override
    // is bypassed by a future change, DOMPurify strips raw h-tags
    // (keeps text content) — visual emphasis is lost but the page
    // outline stays clean.
    'a',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'hr',
    'span', // marked emits checkbox-list spans for GFM task lists
  ],
  ALLOWED_ATTR: [
    'href', 'title',
    'class', // marked emits language-* classes on code fences; harmless
    // Round-2 review AA-H3: tables emit `<th>` rendered by marked
    // without a scope attribute. We inject `scope="col"` for thead th
    // via the afterSanitizeAttributes hook below; that attribute has
    // to be on the allowlist for DOMPurify to keep it.
    'scope',
    // Round-2 review AA-H4 + AA-M5: the hook below stamps `aria-label`
    // on links (new-tab affordance for SR) and `tabindex` on scrollable
    // <pre> blocks (keyboard scrollability for code fences).
    'aria-label',
    'tabindex',
  ],
  // Block javascript: / data: URLs (DOMPurify default is to keep
  // them; tightening here). Allow http(s) + mailto + relative.
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
}

// Hook: force `target="_blank"` + `rel="noopener noreferrer"` on
// every anchor so an LLM-emitted link can't navigate the host page
// out from under the user (and can't access `window.opener`). Also
// inject SR-affording `aria-label` so screen-reader users know a link
// opens in a new tab (round-2 review AA-H4 / WCAG 3.2.5 / G201).
// Tables get `scope="col"` injected on thead `<th>`s for SR
// orientation (AA-H3). Code-fence `<pre>` gets `tabindex="0"` so
// keyboard-only users can horizontally scroll long lines (AA-M5).
//
// Hook idempotency (round-2 review LOW-A2): `removeHook` before
// `addHook` so an HMR-driven module re-import doesn't accumulate
// duplicate hook callbacks on DOMPurify's singleton instance.
let hookRegistered = false
function registerHook(): void {
  if (hookRegistered) return
  // DOMPurify is browser-only here (Vite frontend bundle); the global
  // import yields the configured instance directly. removeAllHooks is
  // overly aggressive (would clear other callers' hooks if they ever
  // register any) — remove only ours by name.
  DOMPurify.removeHook('afterSanitizeAttributes')
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
      // AA-H4: SR affordance for the new-tab behavior. Use the link's
      // visible text as the base name; if the LLM somehow emitted an
      // anchor with no text, fall back to a generic noun. Only set
      // if no aria-label exists (don't clobber LLM-supplied labels).
      if (!node.hasAttribute('aria-label')) {
        const text = (node.textContent ?? '').trim() || 'link'
        node.setAttribute('aria-label', `${text} (opens in new tab)`)
      }
      return
    }
    // AA-H3: marked's GFM tables emit thead > tr > th. Default scope
    // to `col` so SR users orient correctly. If marked ever starts
    // emitting row-headers (it currently doesn't for GFM pipe tables),
    // the LLM-supplied scope wins via the `hasAttribute` guard.
    if (node.tagName === 'TH' && !node.hasAttribute('scope')) {
      node.setAttribute('scope', 'col')
      return
    }
    // AA-M5: code-fence <pre> blocks are scrollable when wide; keyboard
    // users need them focusable to use arrow keys to scroll. Only set
    // if no tabindex is present so a future enhancement that adds
    // tabindex via the renderer (e.g. a copy button focus target)
    // takes precedence.
    if (node.tagName === 'PRE' && !node.hasAttribute('tabindex')) {
      node.setAttribute('tabindex', '0')
      return
    }
  })
  hookRegistered = true
}

// ── Render cache ────────────────────────────────────────────────────
//
// Keyed by `${CACHE_VERSION}:${input}`. Bounded LRU (FIFO eviction;
// access refreshes recency). Solves two problems at once:
//   (a) AgentPage.vue's `renderedMessages` computed re-evaluates on
//       every SSE delta and walks ALL messages — without caching, a
//       long conversation (~20 settled agent bubbles) would re-run
//       marked.parse + DOMPurify.sanitize 20× per token. With cache,
//       each settled bubble's render is a Map.get hit.
//   (b) `renderMarkdownStreaming`'s stable prefix is by construction
//       identical between SSE deltas that haven't crossed a boundary.
//       Cache makes those calls ~free, so the heavy work fires only on
//       boundary transitions.
//
// Size 64 is generous — covers ~30 settled agent messages + 30 stable
// prefix snapshots without thrashing. Eviction is by insertion order:
// access refreshes the entry to "newest", so hot keys survive.
//
// CACHE_VERSION (SE M-1, Thread-10 review): bump whenever the
// configured render pipeline changes — marked.use config, DOMPurify
// allowlist, or the afterSanitizeAttributes hook behavior. Cached
// entries from a prior pipeline version are stale relative to the
// new one; the version prefix ensures they never serve. Bump in the
// same commit as the config change.
const CACHE_VERSION = 1
const RENDER_CACHE_MAX = 64
const renderCache = new Map<string, string>()

function memoizedRender(input: string): string {
  const key = `${CACHE_VERSION}:${input}`
  const cached = renderCache.get(key)
  if (cached !== undefined) {
    // LRU bump: re-insertion moves this key to the tail (newest).
    renderCache.delete(key)
    renderCache.set(key, cached)
    return cached
  }
  let rendered: string
  try {
    rendered = renderInternal(input)
  } catch (err) {
    // CR-5 + RC-M1 (Thread-10 round 1+2 review): defensive fallback so
    // a render failure inside marked + DOMPurify (e.g. a future
    // async-extension throw, a DOMPurify config typo, a malformed input
    // that trips the parser) doesn't propagate up to the Vue computed
    // → render error → entire chat surface blanks. Fall back to
    // plain-text escape: same content visible, no formatting. Forensic
    // log so operators can find the failure in the console. Caches the
    // fallback too so we don't re-throw on every re-render of the same
    // input.
    //
    // RC-M1: defense-in-depth's-defense. If DOMPurify itself throws
    // (config-load error, future API break, missing global jsdom in
    // SSR), fall back to manual HTML-entity escape so the chat surface
    // shows literal text instead of blanking. The minimum entity set
    // closes the parser-breakout surfaces: `&` first (else later
    // replacements get double-encoded), then `<`/`>`/`"`/`'`.
    console.warn('[markdown] render failed; falling back to plain text:', err)
    try {
      rendered = DOMPurify.sanitize(input, { ALLOWED_TAGS: [] })
    } catch (innerErr) {
      console.warn('[markdown] DOMPurify fallback failed; using manual escape:', innerErr)
      rendered = input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
    }
  }
  if (renderCache.size >= RENDER_CACHE_MAX) {
    // Evict oldest entry (Map iteration is insertion order).
    const oldest = renderCache.keys().next().value
    if (oldest !== undefined) renderCache.delete(oldest)
  }
  renderCache.set(key, rendered)
  return rendered
}

function renderInternal(input: string): string {
  registerHook()
  // `marked.parse` returns string | Promise<string> depending on
  // async-extension state. Our `marked.use(...)` config above doesn't
  // register any async extensions, so the sync path returns a string.
  // Round-2 review CR-H3: an earlier comment claimed `v-html` would
  // surface a Promise-typed return as a runtime type error — that
  // was wrong. Vue's v-html accepts anything; a Promise gets
  // stringified to `[object Promise]` and rendered into the DOM. A
  // runtime guard here surfaces the misconfiguration loudly instead
  // of silently rendering "[object Promise]" in the chat surface.
  const parsed = marked.parse(input)
  if (typeof parsed !== 'string') {
    // Defensive: a future async extension would make `marked.parse`
    // return a Promise. Don't render; throw so the breakage is
    // localized to the call site (caught by the agent store's
    // sendMessage catch) instead of leaking "[object Promise]" into
    // every chat bubble.
    throw new Error(
      'renderMarkdownSafe: marked.parse returned a non-string (async extension detected?) — synchronous-only renderer',
    )
  }
  return DOMPurify.sanitize(parsed, PURIFY_CONFIG)
}

/**
 * Render an LLM-emitted markdown string to sanitized HTML. Empty /
 * whitespace-only input returns an empty string (no `<p></p>`
 * wrapper) so the chat bubble stays visually quiet during the
 * pre-first-delta typing indicator. Synchronous; safe to call inside
 * a Vue render function. Memoized — repeated calls with the same
 * string return a cached HTML string by reference (Vue's `v-html`
 * diff treats identical strings as no-op, preserving DOM state +
 * keyboard focus inside the rendered subtree).
 */
export function renderMarkdownSafe(input: string | null | undefined): string {
  if (!input || !input.trim()) return ''
  return memoizedRender(input)
}

/**
 * Streaming-aware split: `text` is partitioned at the last stable
 * boundary into a markdown-rendered prefix + a plain-text suffix.
 *
 * **Why split**: while an SSE stream is in flight, `text` mutates on
 * every delta. Re-rendering the whole string through marked would
 * (a) re-emit HTML for prior chunks and Vue's v-html still replaces
 * the subtree on every delta (focus loss on prior `<a>` elements is
 * a keyboard-user a11y papercut), and (b) treat any mid-stream
 * `\`\`\`` as opening an unclosed fence so prose-after-fence
 * renders as `<pre>` until the closing fence arrives, then
 * "snaps back" to prose. Both are jarring on long replies.
 *
 * **Focus-survival scope**: the split preserves keyboard focus WITHIN
 * a boundary-crossing window — between two consecutive deltas that
 * both fall short of the next stable boundary, the stable HTML string
 * is identical, Vue's v-html short-circuits the innerHTML write
 * (runtime-core compares previous vs. next prop with `===`), and the
 * DOM subtree is untouched. AT the boundary crossing (`\n\n` paragraph
 * end, or `\n` after a markdown block-line — list item, heading,
 * blockquote, hr), the stable HTML string grows; v-html replaces the
 * `markdown-stable` subtree and focus on any anchor within is lost.
 * For the chat use case this is acceptable: focus loss only matters
 * if the user has tabbed INTO a link inside the same in-flight reply,
 * which is rare for streaming content the user is still reading. The
 * stable HTML of SETTLED messages (earlier turns in the conversation)
 * never changes, so anchor focus there survives every delta.
 *
 * **The split**: stable prefix = everything up to (but not past) the
 * last stable boundary as defined by `findStableBoundary` — `\n\n`
 * paragraph terminator, OR single `\n` after a markdown block-line
 * (list item, heading, blockquote, hr). Inflight suffix = the
 * remainder. The stable prefix is rendered through the memoized
 * markdown pipeline (so v-html identity holds across deltas within
 * the same paragraph), and the suffix is template-interpolated as
 * plain text (no `<pre>`, no `<a>` to lose focus on).
 *
 * **Trade-off**: inline formatting in the in-flight paragraph (e.g.
 * `**bold**` mid-stream of an ordinary prose paragraph) renders as
 * literal characters until the paragraph closes with `\n\n`. Accepted:
 * it's a brief flash for
 * one paragraph at a time, and avoids the per-delta DOM-replacement
 * cascade that would lose anchor focus on every prior chunk.
 */
export function renderMarkdownStreaming(
  input: string | null | undefined,
): { stableHtml: string; inflightText: string } {
  if (!input || !input.trim()) {
    return { stableHtml: '', inflightText: '' }
  }
  // CR-4 + RC-H2 (Thread-10 round 1+2 review): normalize CR / CRLF → LF
  // before scanning so a proxy that rewrites line endings (some
  // Cloudflare configurations, some Node reverse-proxy middleware,
  // classic-Mac legacy `\r`-only emitters) doesn't strand the whole
  // reply in the inflight bucket. The boundary scanner only checks for
  // `\n` (0x0A), so a stream with `\r\n\r\n` or bare `\r\r` would never
  // advance. `/\r\n?/g` matches either `\r\n` or a lone `\r`. Single
  // pass; cheap.
  const normalized = input.indexOf('\r') >= 0 ? input.replace(/\r\n?/g, '\n') : input
  const boundary = findStableBoundary(normalized)
  const stableSlice = normalized.slice(0, boundary)
  const inflightSlice = normalized.slice(boundary)
  return {
    stableHtml: stableSlice ? memoizedRender(stableSlice) : '',
    inflightText: inflightSlice,
  }
}

/**
 * `^...` pattern matching markdown block-line prefixes that close
 * cleanly at a single newline (no need to wait for `\n\n`):
 *   - Unordered list items (`- foo`, `* foo`, `+ foo`)
 *   - Ordered list items (`1. foo`, `99. foo`)
 *   - Blockquote lines (`> foo`)
 *   - ATX headings (`# foo` … `###### foo`)
 *   - Horizontal rules (`---`, `___` — at least three; whole-line)
 * Requires a literal space after the marker so emphasis like `*bold*`
 * (no trailing space) is NOT mistaken for a list item, and so a
 * heading-tag `#fragment` URL fragment isn't mistaken for an h1.
 *
 * UX H-2 (Thread-10 review): without per-line advancement, a bulleted
 * reply renders as literal `- a / - b / - c` text in the inflight tail
 * for the entire generation (LLM usually doesn't emit `\n\n` until the
 * whole list closes). Per-line advancement fixes that. Per-bullet
 * advancement does flush the stable HTML each time a new item lands,
 * which means v-html re-renders that subtree on each item — but
 * focus-survival was always scoped to PRIOR settled messages
 * (different `msg.id`, untouched by this re-render). Mid-stream focus
 * on the live message's anchors isn't a real concern because the user
 * hasn't had time to focus on something the LLM just emitted.
 */
const LINE_BLOCK_PREFIX = /^\s*(?:[-*+] |\d+\. |>\s?|#{1,6} |(?:---+|___+|\*\*\*+)\s*$)/

/**
 * Find the index in `text` such that `text.slice(0, index)` is a
 * complete, renderable markdown sub-document — and `text.slice(index)`
 * is "still being typed" (may contain an unclosed code fence, partial
 * inline formatting, etc.). Exported for tests; safe to import in
 * non-test code if a caller needs the boundary index directly.
 *
 * Rules (in order):
 *   - Triple-backtick fences toggle "in-fence" state. While in-fence,
 *     line breaks do NOT advance the boundary. This keeps a multi-line
 *     code block atomic — the whole `<pre>` block flushes to stable
 *     rendering only when the closing fence + the trailing `\n` both
 *     land. Mid-fence streaming text shows as plain text in the
 *     inflight slot (no `<pre>` snap-back).
 *   - Outside a fence, `\n\n` advances the boundary to just past the
 *     second newline (paragraph terminator).
 *   - Outside a fence, a single `\n` advances the boundary IFF the
 *     line just completed matches a markdown block-line prefix (list
 *     item, blockquote, heading, hr). This lets bullet lists stream
 *     line-by-line instead of holding entire lists in the inflight
 *     bucket until the trailing `\n\n` (UX H-2).
 *   - If the text ends mid-fence, the boundary stays at the last
 *     pre-fence stable position (never advances into the unclosed
 *     fence territory). When the fence closes + a stable terminator
 *     lands, the boundary jumps forward.
 *   - If no terminator ever lands AND no fence opens, boundary = 0
 *     (the whole text is inflight — single-paragraph reply being
 *     typed).
 *
 * Triple-backtick detection is permissive (not GFM-strict — fences
 * don't have to be at line-start). The trade-off: a `\`\`\`` inside
 * an inline code span (rare for LLM output) would false-trigger fence
 * state, deferring rendering until the "closing" backticks land.
 * Acceptable for streaming display; the final render via
 * `renderMarkdownSafe` uses marked's actual parser, which IS
 * GFM-strict, so the final HTML is correct.
 */
export function findStableBoundary(text: string): number {
  let inFence = false
  let lastBoundary = 0
  let lineStart = 0
  // RC-M3 (Thread-10 round-2 review): only advance on a single `\n`
  // when the line just completed starts at a BLOCK-ELIGIBLE position —
  // start-of-text, or immediately after a `\n\n` paragraph break, or
  // chained right after another block-line advance (so consecutive
  // list items stream item-by-item). Otherwise a paragraph that grows
  // from "prose\n" to "prose\n- not a list" would mis-flush "prose\n"
  // as stable HTML even though marked's GFM strict parsing would NOT
  // treat the trailing `- not a list` as a list item (requires a
  // preceding blank line). Tracking this avoids the mismatch.
  let isBlockEligible = true
  const len = text.length
  for (let i = 0; i < len; i++) {
    const ch = text.charCodeAt(i)
    // 0x60 === '`'
    if (
      ch === 0x60
      && text.charCodeAt(i + 1) === 0x60
      && text.charCodeAt(i + 2) === 0x60
    ) {
      inFence = !inFence
      i += 2
      continue
    }
    if (ch === 0x0a /* \n */) {
      if (!inFence) {
        if (text.charCodeAt(i + 1) === 0x0a) {
          // `\n\n` paragraph terminator: boundary advances PAST both
          // newlines so the slice ending here includes the paragraph
          // break (marked needs it to close the prior block).
          lastBoundary = i + 2
          i += 1
          lineStart = i + 1
          isBlockEligible = true
          continue
        }
        // Single `\n`: advance only when the line just completed is a
        // self-terminating markdown block-line AND it started at a
        // block-eligible position. For ordinary prose lines, OR
        // continuation-style lines that happen to start with `- `,
        // we keep waiting for `\n\n`.
        const lineContent = text.slice(lineStart, i)
        if (isBlockEligible && LINE_BLOCK_PREFIX.test(lineContent)) {
          lastBoundary = i + 1
          // Keep `isBlockEligible = true` so the NEXT line is also
          // eligible — consecutive list items / consecutive headings
          // should each advance the boundary in turn.
        } else {
          // Non-advancing line: subsequent lines are part of this
          // block's continuation, not fresh blocks.
          isBlockEligible = false
        }
      }
      lineStart = i + 1
    }
  }
  return lastBoundary
}

/**
 * Drop every cached render. Safe to call any time — repeated calls
 * are no-ops; subsequent `renderMarkdownSafe` / `renderMarkdownStreaming`
 * calls just re-render through the marked + DOMPurify pipeline.
 *
 * SE L-1 (Thread-10 review): provided so auth-boundary teardown can
 * clear the module-level cache when wiring `tearDownUserStores`
 * decides to. Today the cache holds rendered HTML keyed by markdown
 * text — output is a pure function of input, so no PII leaks across
 * an auth switch, but the per-user-store hygiene invariant from
 * `feedback_auth_boundary_teardown` is worth honoring with an
 * explicit clear when integrators feel the need.
 */
export function clearMarkdownCache(): void {
  renderCache.clear()
}

/** @deprecated Test-only alias for `clearMarkdownCache`. Retained
 *  for tests that pre-date the public name. */
export const __resetMarkdownCacheForTests = clearMarkdownCache
