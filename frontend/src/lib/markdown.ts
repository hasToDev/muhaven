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
marked.use({
  gfm: true,
  breaks: true,
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
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'a',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'hr',
    'span', // marked emits checkbox-list spans for GFM task lists
  ],
  ALLOWED_ATTR: [
    'href', 'title',
    'class', // marked emits language-* classes on code fences; harmless
  ],
  // Block javascript: / data: URLs (DOMPurify default is to keep
  // them; tightening here). Allow http(s) + mailto + relative.
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
}

// One-time hook: force `target="_blank"` + `rel="noopener noreferrer"`
// on every anchor so an LLM-emitted link can't navigate the host page
// out from under the user (and can't access `window.opener`).
let hookRegistered = false
function registerHook(): void {
  if (hookRegistered) return
  // DOMPurify is browser-only here (Vite frontend bundle); the global
  // import yields the configured instance directly.
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
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
  // register any async extensions, so the sync overload returns a
  // string — cast to assert. If a future contributor adds an async
  // extension, this cast will surface as a runtime type error during
  // the v-html assign rather than silently rendering "[object Promise]".
  const html = marked.parse(input) as string
  return DOMPurify.sanitize(html, PURIFY_CONFIG)
}
