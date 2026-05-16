# MuHaven docs site

User-facing documentation for MuHaven — the confidential RWA portfolio
platform. Focus: the four agentic surfaces (HavenBot, MCP, OpenClaw,
Hosted Checkout).

Production target: **https://docs.muhaven.app** (static deploy, TBD).
Local development: **http://127.0.0.1:5174**.

## Run locally

```bash
cd docs-site
pnpm install          # or npm install / bun install
pnpm dev              # opens VitePress on http://127.0.0.1:5174
```

The dev server hot-reloads on every save. Edits to `.vitepress/config.ts`
or `.vitepress/theme/*` trigger a full reload; markdown edits hot-swap
in place.

## Build for production

```bash
pnpm build            # static output → .vitepress/dist/
pnpm preview          # serves the built site locally on :5174
```

The `dist/` directory is a fully static site — drop it on any
S3+CloudFront / GitHub Pages / Cloudflare Pages / Vercel target.

## Structure

```
docs-site/
├── .vitepress/
│   ├── config.ts              # nav, sidebar, theme tokens
│   └── theme/
│       ├── index.ts           # extends VitePress default theme
│       └── muhaven.css        # Golden Hour Midnight palette overrides
├── public/                    # logos, favicon, og-image
├── index.md                   # home page
├── get-started/               # intro, quickstart, choosing-a-surface, etc.
├── havenbot/                  # in-dashboard copilot
├── mcp/                       # bring-your-own-LLM via @muhaven/mcp
├── openclaw/                  # OpenClaw skill + Telegram bot
├── checkout/                  # hosted-checkout for issuers + buyers
├── policy/                    # tiered-autonomy, session keys, /pause, audit, threats
└── reference/                 # tool catalog, tier matrix, glossary, status
```

## Editing

- Markdown pages use VitePress's [supported markdown extensions](https://vitepress.dev/guide/markdown).
- Custom containers (`::: tip`, `::: warning`, `::: danger`) are themed
  via `.vitepress/theme/muhaven.css` to the warm palette.
- The `mh-card-grid` + `mh-card` helpers are theme-defined; use them on
  the home page and section landing pages for navigation cards.
- Tone: user-facing, second-person, concrete. Avoid implementation
  jargon unless the section explicitly calls for it (e.g.,
  `mcp/broker.md` is detail-heavy by design).

## Style notes (mirrors the dashboard)

- **Palette:** Golden Hour Midnight (dark = warm charcoal #121315 with
  cream-gold + amber accents; light = warm cream #FFFDF7 with
  deep-amber accents).
- **Fonts:** Inter Variable (UI), DM Mono (code). Loaded via VitePress's
  default fontstack — the theme CSS doesn't bundle fontfaces. If you
  want self-hosted fonts (mirroring `frontend/src/assets/styles/`),
  add `@fontsource` packages and import them in `.vitepress/theme/index.ts`.
- **Logo:** `/public/logo.png` (transparent PNG) — used in the nav and
  on the home page hero.
- **No emojis** in body content unless a section deliberately leans on
  one for a quick visual cue (✅ / ❌ in tables, occasional 🪙).

## Deploy to docs.muhaven.app (TODO)

1. Configure Cloudflare DNS for `docs.muhaven.app` → static-host CNAME.
2. Wire a CI workflow on push-to-master that runs `pnpm build` and
   uploads `.vitepress/dist/` to the chosen static host.
3. Mirror the `muhaven-web` deploy pattern in `scripts/deploy-homelab.sh`
   for consistency.

## License

Source under MIT; documentation under CC BY 4.0 unless otherwise noted.
