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

/**
 * Render an LLM-emitted markdown string to sanitized HTML. Empty /
 * whitespace-only input returns an empty string (no `<p></p>`
 * wrapper) so the chat bubble stays visually quiet during the
 * pre-first-delta typing indicator. Synchronous; safe to call inside
 * a Vue render function.
 */
export function renderMarkdownSafe(input: string | null | undefined): string {
  if (!input || !input.trim()) return ''
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
