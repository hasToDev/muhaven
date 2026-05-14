import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

// Sourcemaps are emitted only when MUHAVEN_DEV_BUILD=1 (set by `pnpm dev`'s
// watch loop). The publish path leaves them out — `.js.map`/`.cjs.map`/
// `.d.ts.map` embed `sourcesContent` plus absolute developer paths, which
// is recon material on npm and doubles tarball size with code already
// public on GitHub. See MCP_PUBLISH_READINESS.md §2.1 (H-1).
const isDevBuild = process.env.MUHAVEN_DEV_BUILD === '1';

// `__SERVER_VERSION__` is injected at build time from package.json so the
// MCP server's `serverInfo.version` (returned in the `initialize` JSON-RPC
// response to every host) stays in lockstep with the published version
// without a second hardcode site in src/server.ts. Closes §3e⁶
// F-mcp-serverinfo-version-stale.
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf-8')) as {
  version: string;
};

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
  define: {
    __SERVER_VERSION__: JSON.stringify(pkg.version),
  },
});
