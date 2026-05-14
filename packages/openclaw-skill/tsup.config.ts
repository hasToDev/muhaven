import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

// Sourcemaps are emitted only when MUHAVEN_DEV_BUILD=1 (set by `pnpm dev`'s
// watch loop). The publish/pack path leaves them out — `.js.map`/`.cjs.map`
// embed `sourcesContent` plus absolute developer paths, which is recon
// material on a public ClawHub tarball and doubles tarball size with code
// already public on GitHub. Mirrors the H-1 fix on @muhaven/mcp
// (MCP_PUBLISH_READINESS.md §2.1).
const isDevBuild = process.env.MUHAVEN_DEV_BUILD === '1';

// `__SKILL_VERSION__` is injected at build time from package.json so the
// skill's runtime telemetry (`MUHAVEN_OPENCLAW_SKILL_VERSION` env var)
// stays in lockstep with the npm-shaped version without a 4th hardcode
// site in src/. Pre-publish review caught this 2026-05-11.
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf-8')) as {
  version: string;
};

// `__SERVER_VERSION__` is sourced from packages/mcp's package.json so that
// when @muhaven/mcp is inline-bundled (see noExternal below), the bundled
// MCP server's `serverInfo.version` still resolves correctly via tsup
// `define` — otherwise the inline-bundled `__SERVER_VERSION__ ?? '0.0.0-dev'`
// fallback in server.ts kicks in and silently regresses the very
// `serverInfo.version` fix Q2 ships. Pre-publish review caught this 2026-05-16.
const mcpPkg = JSON.parse(
  readFileSync(join(here, '..', 'mcp', 'package.json'), 'utf-8'),
) as { version: string };

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: isDevBuild,
  clean: true,
  target: 'node20',
  outDir: 'dist',
  splitting: false,
  treeshake: true,
  shims: true,
  // Inline-bundle `@muhaven/mcp` AND its heavy transitive deps into the
  // skill's dist so the ClawHub tarball is truly self-contained. ClawHub
  // v0.12.3 extracts the tarball but does NOT run `npm install` to fetch
  // transitive deps; bundling only `@muhaven/mcp` would still leave the
  // SDK + viem + zod unresolved at runtime. Bundling ALL of them closes
  // ClawScan #3 + §3e⁶ F-clawhub-install-no-npm-install (HIGH).
  //
  // `@napi-rs/keyring` is intentionally NOT bundled — it's declared as
  // an `optionalDependencies` of @muhaven/mcp for platform-specific
  // native bindings, and bundling it would force one platform's binary
  // into every tarball. The skill's bundled @muhaven/mcp keystore.ts
  // already falls back to FileKeystore when the native dep is absent
  // (`MUHAVEN_KEYRING=file`); operators who want OS-keychain backing
  // can `npm install -g @muhaven/mcp` (still recommended for the
  // `muhaven-broker` daemon bin anyway, per SKILL.md "How to install").
  noExternal: [
    '@muhaven/mcp',
    '@modelcontextprotocol/sdk',
    'viem',
    'zod',
  ],
  define: {
    __SKILL_VERSION__: JSON.stringify(pkg.version),
    __SERVER_VERSION__: JSON.stringify(mcpPkg.version),
  },
});
