import { describe, it, expect, beforeEach, vi } from 'vitest'
import { marked } from 'marked'
import {
  renderMarkdownSafe,
  renderMarkdownStreaming,
  findStableBoundary,
  clearMarkdownCache,
} from '@/lib/markdown'

beforeEach(() => {
  clearMarkdownCache()
})

describe('renderMarkdownSafe', () => {
  it('renders bold + lists', () => {
    const html = renderMarkdownSafe('**hi** and\n- one\n- two')
    expect(html).toContain('<strong>hi</strong>')
    expect(html).toMatch(/<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/)
  })

  it('demotes h1-h6 to <p><strong>', () => {
    const html = renderMarkdownSafe('# Heading text')
    expect(html).not.toContain('<h1>')
    expect(html).toContain('<p><strong>Heading text</strong></p>')
  })

  it('returns empty string for null/empty/whitespace', () => {
    expect(renderMarkdownSafe(null)).toBe('')
    expect(renderMarkdownSafe(undefined)).toBe('')
    expect(renderMarkdownSafe('')).toBe('')
    expect(renderMarkdownSafe('   \n  \n')).toBe('')
  })

  it('strips javascript: URIs from links', () => {
    const html = renderMarkdownSafe('[click](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
  })

  it('stamps target=_blank + rel + aria-label on anchors', () => {
    const html = renderMarkdownSafe('[arbiscan](https://arbiscan.io/)')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('aria-label="arbiscan (opens in new tab)"')
  })

  it('returns identical string reference on repeated calls (memoized)', () => {
    // The cache is by string-equality of the rendered HTML, but the
    // important contract for v-html is that two calls with the same
    // input produce the same string content (Vue's v-html diff is
    // value-equality, not reference-equality). Verify content stability.
    const a = renderMarkdownSafe('Hello **world**')
    const b = renderMarkdownSafe('Hello **world**')
    expect(a).toBe(b)
  })
})

describe('findStableBoundary', () => {
  it('returns 0 when no paragraph break and no fence', () => {
    expect(findStableBoundary('partial reply')).toBe(0)
  })

  it('returns boundary past the last \\n\\n', () => {
    const text = 'first paragraph\n\nsecond para in progress'
    const boundary = findStableBoundary(text)
    expect(text.slice(0, boundary)).toBe('first paragraph\n\n')
    expect(text.slice(boundary)).toBe('second para in progress')
  })

  it('returns last \\n\\n boundary (not the first) when multiple', () => {
    const text = 'p1\n\np2\n\np3 in flight'
    const boundary = findStableBoundary(text)
    expect(text.slice(0, boundary)).toBe('p1\n\np2\n\n')
  })

  it('treats unclosed code fence as inflight (stays at last pre-fence boundary)', () => {
    const text = 'Intro paragraph.\n\n```js\nlet x = 1\nlet y = 2'
    const boundary = findStableBoundary(text)
    expect(text.slice(0, boundary)).toBe('Intro paragraph.\n\n')
    expect(text.slice(boundary)).toContain('```js')
  })

  it('does NOT advance boundary on \\n\\n inside an unclosed fence', () => {
    // An LLM-emitted code block may legitimately contain a blank line
    // between functions. Until the closing fence lands, the WHOLE
    // fence stays in the inflight bucket.
    const text = 'Code:\n\n```py\ndef foo():\n    pass\n\ndef bar():\n    pass'
    const boundary = findStableBoundary(text)
    expect(text.slice(0, boundary)).toBe('Code:\n\n')
  })

  it('advances boundary past closed fence when \\n\\n follows', () => {
    const text = 'Code:\n\n```py\nfoo()\n```\n\nAfter prose in flight'
    const boundary = findStableBoundary(text)
    expect(text.slice(0, boundary)).toBe('Code:\n\n```py\nfoo()\n```\n\n')
    expect(text.slice(boundary)).toBe('After prose in flight')
  })

  it('handles fence-open immediately at start', () => {
    const text = '```js\nlet x'
    expect(findStableBoundary(text)).toBe(0)
  })

  it('handles multiple closed fences', () => {
    const text = '```a\nx\n```\n\n```b\ny\n```\n\nMore prose...'
    const boundary = findStableBoundary(text)
    expect(text.slice(0, boundary)).toBe('```a\nx\n```\n\n```b\ny\n```\n\n')
  })

  it('returns 0 for empty input', () => {
    expect(findStableBoundary('')).toBe(0)
  })
})

describe('renderMarkdownStreaming', () => {
  it('returns empty pieces for empty / whitespace input', () => {
    expect(renderMarkdownStreaming('')).toEqual({ stableHtml: '', inflightText: '' })
    expect(renderMarkdownStreaming(null)).toEqual({ stableHtml: '', inflightText: '' })
    expect(renderMarkdownStreaming('  \n  ')).toEqual({ stableHtml: '', inflightText: '' })
  })

  it('puts the whole single-paragraph reply in inflightText', () => {
    const r = renderMarkdownStreaming('In progress reply with no boundary yet')
    expect(r.stableHtml).toBe('')
    expect(r.inflightText).toBe('In progress reply with no boundary yet')
  })

  it('renders stable paragraphs through markdown + leaves the tail plain', () => {
    const r = renderMarkdownStreaming('First **paragraph**.\n\nSecond para being typed')
    expect(r.stableHtml).toContain('<strong>paragraph</strong>')
    expect(r.inflightText).toBe('Second para being typed')
  })

  it('does NOT render an unclosed code fence as <pre> (snap-back fix)', () => {
    // The core bug we're fixing: mid-stream `\`\`\`js` should NOT
    // generate a `<pre>` block in the stable HTML. It stays as
    // plain text in the inflight tail until the closing fence lands.
    const r = renderMarkdownStreaming('Here is code:\n\n```js\nfunction foo() {\n  return 42')
    expect(r.stableHtml).not.toContain('<pre>')
    expect(r.stableHtml).not.toContain('<code>')
    expect(r.inflightText).toContain('```js')
    expect(r.inflightText).toContain('function foo()')
  })

  it('flushes the fence to stableHtml once it closes + \\n\\n lands', () => {
    const r = renderMarkdownStreaming(
      'Here is code:\n\n```js\nlet x = 1\n```\n\nAnd more prose',
    )
    // DOMPurify's afterSanitizeAttributes hook stamps `tabindex="0"` on
    // <pre> (AA-M5 fix). Match the tag-open prefix, not the bare `<pre>`.
    expect(r.stableHtml).toMatch(/<pre[\s>]/)
    expect(r.stableHtml).toContain('let x = 1')
    expect(r.inflightText).toBe('And more prose')
  })

  it('preserves stableHtml identity across deltas within the same paragraph', () => {
    // The keyboard-focus a11y fix relies on identical string output
    // for the stable prefix when only the inflight tail changes.
    // v-html diff is by value-equality: identical string → no DOM
    // replacement → focus inside prior `<a>` survives.
    const stableA = renderMarkdownStreaming(
      'First **paragraph** with [link](https://example.com/).\n\nSecond para frame A',
    ).stableHtml
    const stableB = renderMarkdownStreaming(
      'First **paragraph** with [link](https://example.com/).\n\nSecond para frame B that is longer',
    ).stableHtml
    expect(stableA).toBe(stableB)
    expect(stableA).toContain('<a')
    expect(stableA).toContain('target="_blank"')
  })

  it('preserves stableHtml identity when only the unclosed fence content grows', () => {
    const a = renderMarkdownStreaming('Intro **bold**.\n\n```\nlet x').stableHtml
    const b = renderMarkdownStreaming('Intro **bold**.\n\n```\nlet x = 1').stableHtml
    expect(a).toBe(b)
    expect(a).toContain('<strong>bold</strong>')
  })

  it('handles the canonical "first token under typing-indicator" case', () => {
    // Right after the first SSE delta lands, msg.text is something like
    // "Sure" with no boundary yet. The chat surface shows the typing
    // indicator alongside the inflight tail "Sure" as plain text — no
    // marked render, no <p></p> wrapper polluting the surface.
    const r = renderMarkdownStreaming('Sure')
    expect(r.stableHtml).toBe('')
    expect(r.inflightText).toBe('Sure')
  })

  it('handles a closed fence followed by inflight text WITHOUT trailing \\n\\n', () => {
    // Fence closes but the LLM hasn't yet emitted the post-fence \n\n —
    // post-fence prose appears in the inflight tail. Acceptable
    // because the boundary advances on \n\n, not on fence-close alone.
    const r = renderMarkdownStreaming('```\nx\n```\nimmediate prose')
    expect(r.stableHtml).toBe('')
    expect(r.inflightText).toBe('```\nx\n```\nimmediate prose')
  })

  it('strips XSS-attempt anchor through the same DOMPurify pipeline', () => {
    const r = renderMarkdownStreaming(
      'Watch out [evil](javascript:steal()) link.\n\nNext para',
    )
    expect(r.stableHtml).not.toContain('javascript:')
  })

  // ── CR-4 + RC-H2 (Thread-10 round 1+2 review) — line-ending normalization ──
  it('normalizes CRLF before scanning so proxied SSE streams find boundaries', () => {
    // Some Cloudflare configurations / Node reverse-proxy middleware
    // rewrite line endings. Without normalization the streaming
    // boundary detector would never advance and the whole reply
    // would sit in the inflight bucket.
    const r = renderMarkdownStreaming('first paragraph\r\n\r\nsecond para being typed')
    expect(r.stableHtml).toContain('<p>first paragraph</p>')
    expect(r.inflightText).toBe('second para being typed')
  })

  it('normalizes BARE \\r (classic-Mac line endings)', () => {
    // RC-H2: round-1 normalization missed `\r` without a following
    // `\n`. Classic-Mac-style proxies emit lone `\r`. Without the
    // tightened regex the boundary never advances. The fix uses
    // `/\r\n?/g` which matches either `\r\n` or a lone `\r`.
    const r = renderMarkdownStreaming('first paragraph\r\rsecond para being typed')
    expect(r.stableHtml).toContain('<p>first paragraph</p>')
    expect(r.inflightText).toBe('second para being typed')
  })

  // ── UX H-2 (Thread-10 review) — line-level advance on block lines ──
  describe('line-level advance for markdown block lines', () => {
    it('advances past each unordered list item on single \\n', () => {
      const r = renderMarkdownStreaming('- alpha\n- bravo')
      expect(r.stableHtml).toContain('<li>alpha</li>')
      expect(r.inflightText).toBe('- bravo')
    })

    it('advances past ordered list items', () => {
      const r = renderMarkdownStreaming('1. step one\n2. step two')
      expect(r.stableHtml).toContain('step one')
      expect(r.inflightText).toBe('2. step two')
    })

    it('advances past blockquote lines on single \\n', () => {
      const r = renderMarkdownStreaming('> quoted text\nfollowing prose')
      expect(r.stableHtml).toContain('<blockquote>')
      expect(r.inflightText).toBe('following prose')
    })

    it('advances past heading lines on single \\n', () => {
      // marked.use heading override → <p><strong>...</strong></p>
      const r = renderMarkdownStreaming('# A heading\nfollowing prose')
      expect(r.stableHtml).toContain('<strong>A heading</strong>')
      expect(r.inflightText).toBe('following prose')
    })

    it('advances past horizontal rule lines on single \\n', () => {
      const r = renderMarkdownStreaming('---\nMore prose')
      // marked renders --- as <hr>; our DOMPurify allowlist includes hr.
      expect(r.stableHtml).toContain('<hr>')
      expect(r.inflightText).toBe('More prose')
    })

    it('does NOT advance on a plain prose single \\n (paragraph soft-wrap)', () => {
      // A line that doesn't match any block-prefix is treated as a
      // soft-wrapped paragraph; boundary waits for `\n\n`.
      const r = renderMarkdownStreaming('soft-wrapped line one\nsoft-wrapped line two in progress')
      expect(r.stableHtml).toBe('')
      expect(r.inflightText).toBe('soft-wrapped line one\nsoft-wrapped line two in progress')
    })

    it('does NOT misidentify emphasis as list item (`*foo*` without trailing space)', () => {
      // `*foo*` (no space after `*`) is emphasis, not a list item.
      // The regex `[-*+] ` requires a literal space — emphasis fails it.
      const r = renderMarkdownStreaming('*emphasized*\nmore prose')
      expect(r.stableHtml).toBe('')
      // The full text stays in the inflight bucket; emphasis won't
      // render until the paragraph closes.
    })

    it('does NOT advance past a soft-wrap continuation that happens to start with `- ` (RC-M3)', () => {
      // marked GFM strict does NOT treat `prose\n- foo\n` as a list
      // (requires a preceding blank line). Our scanner mirrors that
      // by tracking `isBlockEligible`: after a non-block-line was
      // consumed (the `prose\n`), the subsequent `- foo` line is
      // a continuation, not a fresh block-line — so the boundary
      // does NOT advance past it.
      const r = renderMarkdownStreaming('prose paragraph\n- not a list item\n')
      expect(r.stableHtml).toBe('')
      expect(r.inflightText).toBe('prose paragraph\n- not a list item\n')
    })

    it('still advances on consecutive bullets after a paragraph break (chains correctly)', () => {
      // After `\n\n` the next line is block-eligible. A list item
      // there advances the boundary; subsequent list items chain
      // (each one re-establishes block-eligibility for the next).
      const r = renderMarkdownStreaming('intro paragraph.\n\n- alpha\n- bravo\n- charlie')
      expect(r.stableHtml).toContain('<li>alpha</li>')
      expect(r.stableHtml).toContain('<li>bravo</li>')
      expect(r.inflightText).toBe('- charlie')
    })
  })

  // ── CR-5 + RC-M1 (Thread-10 round 1+2 review) — defensive fallback ──
  it('falls back to plain-text escape when marked.parse throws', () => {
    // The fallback path was deliberately untested in round 1
    // (couldn't easily mock marked.parse); RC-M1 surfaced this as
    // a coverage gap. Spy on marked.parse, force it to throw, and
    // assert the fallback HTML contains the input content
    // escaped (not rendered as markdown).
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const parseSpy = vi.spyOn(marked, 'parse').mockImplementation(() => {
      throw new Error('synthetic marked.parse failure')
    })
    try {
      const html = renderMarkdownSafe('**should not bold**')
      // Plain-text fallback: DOMPurify with no allowed tags strips
      // the `**` formatting markers as literal text (or they survive
      // as visible `*` characters — depends on DOMPurify's handling
      // of the markdown chars in HTML context). Either way, no
      // `<strong>` should appear.
      expect(html).not.toContain('<strong>')
      // The forensic warn fired.
      expect(warnSpy).toHaveBeenCalled()
      // The cache stored the fallback so a second call doesn't
      // re-throw + re-warn.
      warnSpy.mockClear()
      const html2 = renderMarkdownSafe('**should not bold**')
      expect(html2).toBe(html)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      parseSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  // ── SE I3 (Thread-10 review) — inflight-tail XSS posture ──
  it('treats inflight tail content as plain text (Vue interpolation context)', () => {
    // The streaming split returns the inflight tail as a raw string.
    // The caller is expected to bind it via `{{ }}` interpolation —
    // Vue's `toDisplayString` writes via `textContent`, which preserves
    // `<`, `>`, `&` as visible characters and CANNOT inject parsed
    // HTML. This test pins the API contract: `inflightText` returns
    // verbatim text, NOT pre-escaped HTML. Vue handles escaping.
    const r = renderMarkdownStreaming('First paragraph.\n\n<script>alert(1)</script>')
    // The malicious sequence has no `\n\n` after it, so it sits in
    // the inflight bucket verbatim. The caller (AgentPage v-html
    // binding) never routes this through v-html.
    expect(r.inflightText).toContain('<script>alert(1)</script>')
    expect(r.stableHtml).not.toContain('<script>')
  })
})
