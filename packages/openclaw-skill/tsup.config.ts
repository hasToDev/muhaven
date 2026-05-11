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
  define: {
    __SKILL_VERSION__: JSON.stringify(pkg.version),
  },
});
