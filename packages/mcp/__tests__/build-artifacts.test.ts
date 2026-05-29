/**
 * Publish-bundle hygiene regressions.
 *
 * H-1 (MCP_PUBLISH_READINESS.md §2.1): the `tsup` config emits sourcemaps
 * only when `MUHAVEN_DEV_BUILD=1`. Without that gate, every publish would
 * ship `.js.map` / `.cjs.map` / `.d.ts.map` — `sourcesContent` plus
 * absolute developer paths — to npm. This test asserts the build path
 * leaves them out.
 *
 * Hostname-migration guard (added 2026-05-11): the 2026-05-11 commit
 * `30aa047` rotated every runtime default from `*.hasto.dev` →
 * `muhaven.app`, but stale `dist/` artifacts produced before the rotation
 * still embedded the old hosts. `pnpm pack` would have shipped them to
 * npm — first-call default backend would 404. This test fails if any
 * compiled bundle still mentions a `*.hasto.dev` host so a stale rebuild
 * cannot smuggle a poison default onto the registry.
 *
 * The test silently skips when `dist/` is absent (CI / dev environments
 * may run vitest before `pnpm build`); the merge-gate workflow runs
 * `pnpm --filter @muhaven/mcp build` before `pnpm test`, so the assertion
 * always fires there.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

describe('publish artifact hygiene', () => {
  const dist = join(__dirname, '..', 'dist');

  it('dist/ contains no .map files in the publish build', () => {
    if (!existsSync(dist)) return;
    if (process.env.MUHAVEN_DEV_BUILD === '1') return;
    const maps = readdirSync(dist).filter((f) => f.endsWith('.map'));
    expect(maps).toEqual([]);
  });

  it('dist/*.{js,cjs} do not embed pre-migration *.hasto.dev hostnames', () => {
    if (!existsSync(dist)) return;
    const bundles = readdirSync(dist).filter(
      (f) => (f.endsWith('.js') || f.endsWith('.cjs')) && statSync(join(dist, f)).isFile(),
    );
    const offenders: string[] = [];
    for (const f of bundles) {
      const content = readFileSync(join(dist, f), 'utf-8');
      if (/\b[a-z0-9-]+\.hasto\.dev\b/i.test(content)) {
        offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('dist/{index,broker,reinvest}.{js,cjs} embed the package.json version via __SERVER_VERSION__ inject', () => {
    // Q2 regression guard: the tsup `define` block replaces
    // `__SERVER_VERSION__` with package.json#version at build time. A
    // future tsup config edit that drops the define would silently
    // downgrade the bundled server's `serverInfo.version` to the
    // '0.0.0-dev' fallback in `src/server.ts:resolveServerVersion`. This
    // test fails when the bundled dist doesn't carry the literal version
    // string from the current package.json.
    if (!existsSync(dist)) return;
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'),
    ) as { version: string };
    // All three entries get the tsup `define` inject; a per-entry regression
    // (or a dropped global define) would downgrade broker/reinvest `--version`
    // to the fragile require fallback. Guard all three.
    const bundles = ['index.js', 'index.cjs', 'broker.js', 'broker.cjs', 'reinvest.js', 'reinvest.cjs'];
    const missing: string[] = [];
    for (const f of bundles) {
      const path = join(dist, f);
      if (!existsSync(path)) continue;
      const content = readFileSync(path, 'utf-8');
      // We look for the literal version string in a context that proves
      // it came from the tsup define (the `resolveServerVersion` body
      // returns the literal directly). A bare substring search is fine
      // because no other code in dist mentions the version.
      if (!content.includes(`"${pkg.version}"`)) {
        missing.push(`${f} (looking for "${pkg.version}")`);
      }
    }
    expect(missing).toEqual([]);
  });
});
