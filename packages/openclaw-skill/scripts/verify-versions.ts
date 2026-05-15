/**
 * Four-way version-equality gate across the openclaw-skill bundle:
 *
 *   1. `package.json#version`
 *   2. `manifest.json#version`
 *   3. `config.json#version`            (ClawSecure runtime config)
 *   4. `SKILL.md` frontmatter `version:` (operator-facing doc)
 *
 * Plus a separate cross-package gate:
 *   - `manifest.json#mcp.bundled_version` == `packages/mcp/package.json#version`
 *
 * Optionally a tag/dispatch gate (set by `openclaw-skill-publish.yml`):
 *   - env `TAG_VERSION` (stripped of `openclaw-skill-v` prefix by caller)
 *     must equal the skill version.
 *
 * Mirrors the regex patterns in `__tests__/manifest-consistency.test.ts`
 * and `scripts/verify-subset.ts` so local test, local script, and CI gate
 * all parse SKILL.md frontmatter byte-for-byte the same way.
 *
 * Designed to be runnable BEFORE the workspace build (no `@muhaven/mcp`
 * import), so the CI publish workflow can fail-fast in ~5 seconds on a
 * version-skew tag instead of ~2 minutes into the run.
 *
 * Exits 0 on full match, 1 on any skew.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const skillRoot = join(here, '..');
const repoRoot = join(skillRoot, '..', '..');

function readJsonVersion(path: string, label: string): string {
  const raw = readFileSync(path, 'utf-8');
  const pkg = JSON.parse(raw) as { version?: unknown };
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error(`${label} has no usable "version" field at ${path}`);
  }
  return pkg.version;
}

function readManifestBundledVersion(): string {
  const raw = readFileSync(join(skillRoot, 'manifest.json'), 'utf-8');
  const m = JSON.parse(raw) as { mcp?: { bundled_version?: unknown } };
  const v = m.mcp?.bundled_version;
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error('manifest.json#mcp.bundled_version missing or empty');
  }
  return v;
}

function readSkillMdVersion(): string {
  const raw = readFileSync(join(skillRoot, 'SKILL.md'), 'utf-8');
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) {
    throw new Error('SKILL.md frontmatter not found (expected leading --- ... --- block)');
  }
  const m = fm[1].match(/^[ \t]*version:[ \t]*["']?([^"'\r\n#]+?)["']?[ \t]*(?:#.*)?$/m);
  if (!m) {
    throw new Error('SKILL.md frontmatter has no "version:" line');
  }
  return m[1].trim();
}

interface Sites {
  pkg: string;
  manifest: string;
  config: string;
  skillMd: string;
  tag?: string;
}

function loadSites(): Sites {
  const pkg = readJsonVersion(join(skillRoot, 'package.json'), 'package.json');
  const manifest = readJsonVersion(join(skillRoot, 'manifest.json'), 'manifest.json');
  const config = readJsonVersion(join(skillRoot, 'config.json'), 'config.json');
  const skillMd = readSkillMdVersion();
  const tagRaw = process.env.TAG_VERSION?.trim();
  const tag = tagRaw && tagRaw.length > 0 ? tagRaw : undefined;
  return { pkg, manifest, config, skillMd, tag };
}

function reportSkew(sites: Sites): void {
  console.error('Version skew across openclaw-skill sites:');
  console.error(`  package.json          = ${sites.pkg}`);
  console.error(`  manifest.json         = ${sites.manifest}`);
  console.error(`  config.json           = ${sites.config}`);
  console.error(`  SKILL.md frontmatter  = ${sites.skillMd}`);
  if (sites.tag !== undefined) {
    console.error(`  tag/dispatch          = ${sites.tag}`);
  }
  console.error('');
  console.error('Bump all four sites together. See memory feedback_openclaw_skill_version_sites.');
}

function main(): void {
  const sites = loadSites();

  const target = sites.pkg;
  const mismatched =
    sites.manifest !== target ||
    sites.config !== target ||
    sites.skillMd !== target ||
    (sites.tag !== undefined && sites.tag !== target);

  if (mismatched) {
    reportSkew(sites);
    process.exit(1);
  }

  const bundled = readManifestBundledVersion();
  const mcpPkg = readJsonVersion(join(repoRoot, 'packages', 'mcp', 'package.json'), 'packages/mcp/package.json');
  if (bundled !== mcpPkg) {
    console.error('Bundled MCP version skew:');
    console.error(`  manifest.json#mcp.bundled_version  = ${bundled}`);
    console.error(`  packages/mcp/package.json#version  = ${mcpPkg}`);
    process.exit(1);
  }

  const tagSuffix = sites.tag !== undefined ? ' + tag/dispatch' : '';
  console.log(
    `version: ${target} (matched across package.json + manifest.json + config.json + SKILL.md frontmatter${tagSuffix}); bundled @muhaven/mcp pinned to ${bundled}`,
  );
}

main();
