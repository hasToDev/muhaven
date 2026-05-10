#!/usr/bin/env node
// Wave 4 P4 — bundle the Telegram Mini App into the staging frontend dist.
//
// Why bundling into the SPA's dist (rather than a separate
// muhaven-mini-app-stage repo): the Mini App is a tiny static bundle
// (~10 KB JS) and Telegram serves it from any HTTPS origin. Sharing
// the SPA's host avoids provisioning a second Cloudflare-Pages route
// and keeps the WebAuthn RP-ID consistent for the >$5K passkey tier
// (which deeplinks back to the dashboard).
//
// Build flow (from `frontend/`):
//   1. The frontend's `build:stage` already produces `frontend/dist/`.
//   2. THIS script runs after, pnpm-builds the Mini App into
//      `apps/telegram-mini-app/dist/`, then copies it to
//      `frontend/dist/telegram-mini-app/`.
//   3. The frontend's existing `deploy-to-muhaven-web.mjs` mirrors
//      `frontend/dist/` → `../../muhaven-web-stage/`, so the bundled
//      Mini App rides along.
//
// Cloudflare Pages SPA-fallback rule must NOT intercept
// `/telegram-mini-app/*` — the Mini App's `index.html` lives at that
// path and serving the SPA's `index.html` instead would break the
// initData entry-point. The frontend's existing deploy treats every
// path under dist/ as static, so as long as the file exists at the
// path Pages will serve it directly.
//
// `MODE` env var:
//   - 'stage' (default): runs `pnpm --filter @muhaven/telegram-mini-app build:stage`
//   - 'prod':            runs `pnpm --filter @muhaven/telegram-mini-app build`
// (matches the frontend's `build` vs `build:stage` split — prod ships
// the Mini App with the production backend URL hard-baked.)

import { spawn } from 'node:child_process';
import { access, cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../..');
const miniAppDir = resolve(repoRoot, 'apps/telegram-mini-app');
const miniAppDist = resolve(miniAppDir, 'dist');
const frontendDist = resolve(scriptDir, '../dist');
const targetSubdir = resolve(frontendDist, 'telegram-mini-app');

const mode = process.env.MODE === 'prod' ? 'prod' : 'stage';
const buildScript = mode === 'prod' ? 'build' : 'build:stage';

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: true, ...opts });
    child.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${cmd} ${args.join(' ')} exited ${code}`))));
  });
}

async function main() {
  if (!(await exists(frontendDist))) {
    throw new Error(
      `frontend/dist/ not found at ${frontendDist} — run \`bun run build:stage\` first; this script is designed to chain after.`,
    );
  }
  console.log(`==> Building Mini App (mode=${mode})...`);
  await run('pnpm', ['--filter', '@muhaven/telegram-mini-app', buildScript], { cwd: repoRoot });
  if (!(await exists(miniAppDist))) {
    throw new Error(`Mini App dist not produced at ${miniAppDist}.`);
  }
  if (await exists(targetSubdir)) {
    await rm(targetSubdir, { recursive: true, force: true });
  }
  await mkdir(targetSubdir, { recursive: true });
  await cp(miniAppDist, targetSubdir, { recursive: true, force: true });
  console.log(`✓ Mini App bundled into ${targetSubdir}`);
}

main().catch((err) => {
  console.error('✗ bundle-telegram-mini-app failed:', err?.message ?? err);
  process.exitCode = 1;
});
