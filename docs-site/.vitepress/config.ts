import { defineConfig } from 'vitepress'

// MuHaven user-facing documentation site.
// Run locally with `pnpm dev` (or `npm run dev`); served on http://127.0.0.1:5174.
// Production target: https://docs.muhaven.app — static output of `pnpm build` to dist/.
export default defineConfig({
  title: 'MuHaven Docs',
  description:
    'User guide for MuHaven — the confidential RWA portfolio with four agentic surfaces (HavenBot, MCP, OpenClaw, Hosted Checkout).',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  appearance: 'dark',
  srcExclude: ['**/README.md'],
  head: [
    ['link', { rel: 'icon', href: '/favicon.ico' }],
    ['meta', { name: 'theme-color', content: '#121315' }],
    [
      'meta',
      {
        property: 'og:title',
        content: 'MuHaven Docs — Confidential RWA, agentic-first',
      },
    ],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'Use HavenBot, the @muhaven/mcp server, the OpenClaw skill, or the hosted checkout to drive your confidential RWA portfolio.',
      },
    ],
    ['meta', { property: 'og:image', content: '/banner.png' }],
  ],
  themeConfig: {
    logo: {
      src: '/logo-small.png',
      alt: 'MuHaven',
      width: 28,
      height: 28,
    },
    siteTitle: 'MuHaven',
    nav: [
      { text: 'Get Started', link: '/get-started/introduction', activeMatch: '^/get-started/' },
      { text: 'HavenBot', link: '/havenbot/overview', activeMatch: '^/havenbot/' },
      { text: 'MCP', link: '/mcp/overview', activeMatch: '^/mcp/' },
      { text: 'OpenClaw', link: '/openclaw/overview', activeMatch: '^/openclaw/' },
      { text: 'Checkout', link: '/checkout/overview', activeMatch: '^/checkout/' },
      { text: 'Policy & Safety', link: '/policy/tiered-autonomy', activeMatch: '^/policy/' },
      { text: 'Reference', link: '/reference/tool-catalog', activeMatch: '^/reference/' },
      {
        text: 'App',
        items: [
          { text: 'Dashboard (muhaven.app)', link: 'https://muhaven.app' },
          { text: 'Buyer checkout (muhaven.app/pay)', link: 'https://muhaven.app/pay' },
          { text: 'Public metrics', link: 'https://api.muhaven.app/api/v1/public/metrics' },
        ],
      },
    ],
    sidebar: {
      '/get-started/': [
        {
          text: 'Welcome',
          items: [
            { text: 'Introduction', link: '/get-started/introduction' },
            { text: 'Quickstart', link: '/get-started/quickstart' },
            { text: 'Choosing a surface', link: '/get-started/choosing-a-surface' },
          ],
        },
        {
          text: 'Account',
          items: [
            { text: 'Passkey accounts', link: '/get-started/passkey-accounts' },
            { text: 'Investor vs issuer', link: '/get-started/investor-vs-issuer' },
            { text: 'Privacy boundary', link: '/get-started/privacy-boundary' },
          ],
        },
      ],
      '/havenbot/': [
        {
          text: 'HavenBot — in-dashboard copilot',
          items: [
            { text: 'Overview', link: '/havenbot/overview' },
            { text: 'Onboarding (under 6 minutes)', link: '/havenbot/onboarding' },
            { text: 'Conversations & confirmations', link: '/havenbot/conversations' },
            { text: 'Investor playbook', link: '/havenbot/investor-playbook' },
            { text: 'Issuer playbook', link: '/havenbot/issuer-playbook' },
            { text: 'Troubleshooting', link: '/havenbot/troubleshooting' },
          ],
        },
      ],
      '/mcp/': [
        {
          text: 'MuHaven MCP — bring your own LLM',
          items: [
            { text: 'Overview', link: '/mcp/overview' },
            { text: 'Install', link: '/mcp/install' },
            { text: 'First chat (Claude Code / Desktop / Cursor)', link: '/mcp/first-chat' },
            { text: 'Playbook — scenarios that work', link: '/mcp/playbook' },
            { text: 'Tool catalog', link: '/mcp/tools' },
            { text: 'Broker daemon', link: '/mcp/broker' },
            { text: 'Read-only mode', link: '/mcp/read-only-mode' },
            { text: 'Troubleshooting', link: '/mcp/troubleshooting' },
          ],
        },
      ],
      '/openclaw/': [
        {
          text: 'OpenClaw + Telegram',
          items: [
            { text: 'Overview', link: '/openclaw/overview' },
            { text: 'Install the skill', link: '/openclaw/install-skill' },
            { text: 'Telegram bot', link: '/openclaw/telegram-bot' },
            { text: 'Three confirmation tiers', link: '/openclaw/confirmation-tiers' },
            { text: 'Available tools', link: '/openclaw/tools' },
            { text: 'Playbook — phone-first scenarios', link: '/openclaw/playbook' },
            { text: 'Troubleshooting', link: '/openclaw/troubleshooting' },
          ],
        },
      ],
      '/checkout/': [
        {
          text: 'Hosted Checkout',
          items: [
            { text: 'Overview', link: '/checkout/overview' },
            { text: 'For issuers — create a checkout link', link: '/checkout/for-issuers' },
            { text: 'For buyers — pay with a passkey', link: '/checkout/for-buyers' },
            { text: 'URL fragment key (privacy)', link: '/checkout/fragment-key' },
            { text: 'Webhooks & receipts', link: '/checkout/webhooks' },
            { text: 'Troubleshooting', link: '/checkout/troubleshooting' },
          ],
        },
      ],
      '/policy/': [
        {
          text: 'Policy & Safety',
          items: [
            { text: 'Tiered autonomy', link: '/policy/tiered-autonomy' },
            { text: 'Session keys', link: '/policy/session-keys' },
            { text: 'The /pause kill-switch', link: '/policy/pause' },
            { text: 'Audit log', link: '/policy/audit-log' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Tool catalog (all 4 surfaces)', link: '/reference/tool-catalog' },
            { text: 'Tier matrix', link: '/reference/tier-matrix' },
            { text: 'Glossary', link: '/reference/glossary' },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/hasToDev/muhaven' },
    ],
    footer: {
      message:
        'MuHaven docs — agentic-first. Run locally with <code>pnpm dev</code>; production at <code>docs.muhaven.app</code>.',
      copyright: 'Built on Fhenix CoFHE · Arbitrum · ZeroDev passkey-bound MuHaven wallet.',
    },
    search: {
      provider: 'local',
      options: {
        detailedView: true,
      },
    },
    outline: {
      level: [2, 3],
      label: 'On this page',
    },
    editLink: {
      pattern:
        'https://github.com/hasToDev/muhaven/edit/master/docs-site/:path',
      text: 'Suggest an edit',
    },
    docFooter: {
      prev: 'Previous',
      next: 'Next',
    },
  },
  vite: {
    server: {
      host: '127.0.0.1',
      port: 5174,
      strictPort: true,
    },
  },
})
