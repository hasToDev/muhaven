import { defineConfig } from 'tsup';

// Sourcemaps are emitted only when MUHAVEN_DEV_BUILD=1 (set by `pnpm dev`'s
// watch loop). The publish path leaves them out — `.js.map`/`.cjs.map`/
// `.d.ts.map` embed `sourcesContent` plus absolute developer paths, which
// is recon material on npm and doubles tarball size with code already
// public on GitHub. See MCP_PUBLISH_READINESS.md §2.1 (H-1).
const isDevBuild = process.env.MUHAVEN_DEV_BUILD === '1';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    broker: 'src/broker/cli.ts',
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
});
