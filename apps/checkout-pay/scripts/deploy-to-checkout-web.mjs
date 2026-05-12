#!/usr/bin/env node
// Wave 4 P5 — sync the checkout-pay dist/ contents to the deploy-target repo.
//
// The hosted-checkout buyer page is served from a separate subdomain
// (`pay.muhaven.app` / `pay-stage.muhaven.app`) so the kernel-passkey
// RP-ID resolves correctly against the dashboard's apex. That means it
// CANNOT ride along with `frontend/dist/` (which mirrors to
// `muhaven-web` / `muhaven-web-stage` — different host, different CSP,
// different SPA-fallback route).
//
// Target resolution (mirrors `frontend/scripts/deploy-to-muhaven-web.mjs`,
// adjusted for the extra `apps/` directory level under muhaven/):
//   - MUHAVEN_CHECKOUT_WEB_TARGET_DIR env var, resolved with `apps/checkout-pay/`
//     as base (the `..` prefix on the resolve call walks one up from `scripts/`),
//     if set
//   - otherwise ../../../../muhaven-checkout-web (sibling of muhaven/, the default).
//     Four `..` are needed because scriptDir is `apps/checkout-pay/scripts/` —
//     four levels under the parent of muhaven (scripts → checkout-pay → apps →
//     muhaven → Fhenix). The frontend twin only needs three because
//     `frontend/scripts/` is one level shallower.
//
// Stage build sets:
//   MUHAVEN_CHECKOUT_WEB_TARGET_DIR=../../../muhaven-checkout-web-stage
// (three `..` because the env value is resolved from `apps/checkout-pay/`, not
// from `scripts/` — same shape as the frontend's `MUHAVEN_WEB_TARGET_DIR`.)
//
// Root-level files (CNAME, README.md, .nojekyll — anything not under
// assets/) are NEVER deleted, only overwritten. If the target doesn't
// exist, the script exits cleanly with a warning so a CI build doesn't
// hard-fail on a missing operator-provisioned sibling repo.

import { readdir, rm, cp, access } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const dist = resolve(scriptDir, '../dist');
const targetOverride = process.env.MUHAVEN_CHECKOUT_WEB_TARGET_DIR;
const target = targetOverride
  ? resolve(scriptDir, '..', targetOverride)
  : resolve(scriptDir, '../../../../muhaven-checkout-web');

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
    console.warn(`⚠ muhaven-checkout-web repo not found at ${target} — skipping sync.`);
    console.warn('  (This is expected for CI builds. Clone the deploy-target repo as a sibling of muhaven to enable local deploy.)');
    return;
  }
  if (!(await exists(dist))) {
    throw new Error(`dist/ not found at ${dist} — did vite build run?`);
  }

  // 1. Mirror dist/assets/ into target/assets/: remove stale entries
  //    that aren't in the new build before copying. Vite emits hashed
  //    filenames so old chunks pile up forever without this step.
  const srcAssets = join(dist, 'assets');
  const tgtAssets = join(target, 'assets');

  let srcFiles = new Set();
  if (await exists(srcAssets)) {
    srcFiles = new Set(await readdir(srcAssets));
  }

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

  // 2. Copy all of dist/ on top of target/ — `cp -r` semantics, overwrites
  //    existing files but does not touch anything outside dist/'s namespace.
  await cp(dist, target, { recursive: true, force: true });

  console.log(`✓ Synced dist/ → ${target}`);
  console.log(`  ${srcFiles.size} fresh asset(s); removed ${removedCount} stale asset(s)`);
}

main().catch((err) => {
  console.error('✗ deploy-to-checkout-web failed:', err?.message ?? err);
  process.exitCode = 1;
});
