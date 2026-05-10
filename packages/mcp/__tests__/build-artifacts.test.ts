/**
 * Publish-bundle hygiene regressions.
 *
 * H-1 (MCP_PUBLISH_READINESS.md §2.1): the `tsup` config emits sourcemaps
 * only when `MUHAVEN_DEV_BUILD=1`. Without that gate, every publish would
 * ship `.js.map` / `.cjs.map` / `.d.ts.map` — `sourcesContent` plus
 * absolute developer paths — to npm. This test asserts the build path
 * leaves them out.
 *
 * The test silently skips when `dist/` is absent (CI / dev environments
 * may run vitest before `pnpm build`); the merge-gate workflow runs
 * `pnpm --filter @muhaven/mcp build` before `pnpm test`, so the assertion
 * always fires there.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

describe('publish artifact hygiene', () => {
  const dist = join(__dirname, '..', 'dist');

  it('dist/ contains no .map files in the publish build', () => {
    if (!existsSync(dist)) return;
    if (process.env.MUHAVEN_DEV_BUILD === '1') return;
    const maps = readdirSync(dist).filter((f) => f.endsWith('.map'));
    expect(maps).toEqual([]);
  });
});
