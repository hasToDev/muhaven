#!/usr/bin/env node
// Post-build sync: copies dist/ contents to ../../muhaven-web and mirrors
// dist/assets/ so stale hashed chunks from previous builds get removed.
//
// Root-level files (CNAME, README.md, .nojekyll, logo.jpg, logo.png — anything
// not under assets/) are NEVER deleted, only overwritten when a same-named
// file exists in dist/.
//
// If ../../muhaven-web doesn't exist, the script exits cleanly with a warning
// so `bun run build` still succeeds in non-deploy contexts (CI, Vercel, etc.).

import { readdir, rm, cp, access } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const dist = resolve(scriptDir, '../dist');
const target = resolve(scriptDir, '../../../muhaven-web');

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
    console.warn(`⚠ muhaven-web repo not found at ${target} — skipping sync.`);
    console.warn('  (This is expected for CI builds. Clone muhaven-web as a sibling of muhaven to enable local deploy.)');
    return;
  }
  if (!(await exists(dist))) {
    throw new Error(`dist/ not found at ${dist} — did vite build run?`);
  }

  // 1. Mirror dist/assets/ into muhaven-web/assets/: remove stale entries that
  //    aren't in the new build before copying. Vite emits hashed filenames so
  //    old chunks pile up forever without this step.
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

  // 2. Copy all of dist/ on top of muhaven-web/ — `cp -r` semantics, overwrites
  //    existing files but does not touch anything outside dist/'s namespace.
  await cp(dist, target, { recursive: true, force: true });

  console.log(`✓ Synced dist/ → ${target}`);
  console.log(`  ${srcFiles.size} fresh asset(s); removed ${removedCount} stale asset(s)`);
}

main().catch((err) => {
  console.error('✗ deploy-to-muhaven-web failed:', err?.message ?? err);
  process.exitCode = 1;
});
