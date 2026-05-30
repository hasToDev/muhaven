#!/usr/bin/env node
// Post-build sync: copies VitePress's built site to the sibling GitHub Pages
// repo `muhaven-document-web` and mirrors the assets dir so stale hashed
// chunks from previous builds get removed.
//
// Mirrors `frontend/scripts/deploy-to-muhaven-web.mjs` (the muhaven-web
// recipe) — same delete-stale-then-copy semantics, same root-file
// preservation, same graceful-skip when the target is absent.
//
// Target resolution:
//   - MUHAVEN_DOCUMENT_WEB_TARGET_DIR env var (resolved from docs-site/), if set
//   - otherwise ../../../muhaven-document-web (sibling of muhaven/, the default)
//
// VitePress's build output is `.vitepress/dist/` (NOT `dist/`), so the source
// is resolved relative to that.
//
// Root-level files in the target (CNAME, README.md, .nojekyll — anything not
// under assets/) are NEVER deleted, only overwritten when a same-named file
// exists in the build output.
//
// If the target doesn't exist, the script exits cleanly with a warning so
// `pnpm build` still succeeds in non-deploy contexts (CI, etc.).

import { readdir, rm, cp, access } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const dist = resolve(scriptDir, '../.vitepress/dist');
const targetOverride = process.env.MUHAVEN_DOCUMENT_WEB_TARGET_DIR;
const target = targetOverride
  ? resolve(scriptDir, '..', targetOverride)
  : resolve(scriptDir, '../../../muhaven-document-web');

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(target))) {
    console.warn(`⚠ muhaven-document-web repo not found at ${target} — skipping sync.`);
    console.warn('  (This is expected for CI builds. Clone muhaven-document-web as a sibling of muhaven to enable local deploy.)');
    return;
  }
  if (!(await exists(dist))) {
    throw new Error(`dist/ not found at ${dist} — did vitepress build run?`);
  }

  // 1. Mirror dist/assets/ into target/assets/: remove stale entries that
  //    aren't in the new build before copying. VitePress emits hashed
  //    filenames so old chunks pile up forever without this step.
  const srcAssets = join(dist, 'assets');
  const tgtAssets = join(target, 'assets');

  const srcFiles = new Set(await readdir(srcAssets));

  let removedCount = 0;
  if (await exists(tgtAssets)) {
    const tgtFiles = await readdir(tgtAssets);
    for (const f of tgtFiles) {
      if (!srcFiles.has(f)) {
        await rm(join(tgtAssets, f), { recursive: true, force: true });
        removedCount++;
      }
    }
  }

  // 2. Copy all of dist/ on top of the target — `cp -r` semantics, overwrites
  //    existing files but does not touch anything outside dist/'s namespace
  //    (CNAME / .nojekyll / README.md are preserved).
  await cp(dist, target, { recursive: true, force: true });

  console.log(`✓ Synced .vitepress/dist/ → ${target}`);
  console.log(`  ${srcFiles.size} fresh asset(s); removed ${removedCount} stale asset(s)`);
}

main().catch((err) => {
  console.error('✗ deploy-to-muhaven-document-web failed:', err?.message ?? err);
  process.exitCode = 1;
});
