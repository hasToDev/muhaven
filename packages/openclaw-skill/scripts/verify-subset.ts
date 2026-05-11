/**
 * Three-way subset consistency check between:
 *
 *   1. `src/index.ts` `TOOLSET_SUBSET` constant (runtime filter)
 *   2. `manifest.json` `mcp.tool_subset` array (ClawHub manifest)
 *   3. `SKILL.md` frontmatter `mcp.toolset_subset` list (operator-facing doc)
 *
 * Drift between any pair causes the build to fail. Without this gate, an
 * editor could update the runtime filter without touching the manifest
 * (or vice versa) and ship a skill whose advertised tools don't match
 * what it actually exposes — exactly the shape of the MCPoison family
 * of vulnerabilities, only inverted.
 *
 * Also verifies that every tool in the subset exists in the upstream
 * `@muhaven/mcp` `TOOL_DESCRIPTORS` array — a missing upstream tool is
 * an indication that the bundled MCP version is incompatible.
 *
 * Exits 0 on match, 70 (BSD `EX_CONFIG`) on drift to mirror the upstream
 * mcp-context-protector convention.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_DESCRIPTORS } from '@muhaven/mcp';
import { TOOLSET_SUBSET, TOOLSET_EXCLUDED } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

interface Manifest {
  mcp?: {
    bundled?: string;
    bundled_version?: string;
    tool_subset?: string[];
    tool_subset_excluded?: string[];
  };
  tools?: Array<{ name: string }>;
}

function loadManifest(): Manifest {
  const raw = readFileSync(join(root, 'manifest.json'), 'utf-8');
  return JSON.parse(raw) as Manifest;
}

function loadSkillMdBundledVersion(): string | undefined {
  const raw = readFileSync(join(root, 'SKILL.md'), 'utf-8');
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return undefined;
  const m = fmMatch[1].match(/^[ \t]*bundled_version:[ \t]*["']?([^"'\r\n#]+?)["']?[ \t]*(?:#.*)?$/m);
  return m ? m[1].trim() : undefined;
}

function loadMcpPackageVersion(): string {
  const raw = readFileSync(join(root, '..', 'mcp', 'package.json'), 'utf-8');
  const pkg = JSON.parse(raw) as { version: string };
  return pkg.version;
}

/**
 * Pull the list under the YAML-flavoured frontmatter key
 * `mcp.toolset_subset` from SKILL.md. Cheap line-scan parser — sufficient
 * because the frontmatter is hand-authored and the format is stable.
 * If we ever need a real YAML parser, gray-matter / js-yaml are options;
 * for the hackathon a regex sweep keeps the dep surface minimal.
 */
function loadSkillMdSubset(key: 'toolset_subset' | 'toolset_excluded'): string[] {
  const raw = readFileSync(join(root, 'SKILL.md'), 'utf-8');
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) {
    throw new Error('SKILL.md frontmatter not found (expected leading --- ... --- block)');
  }
  const fm = fmMatch[1];
  // Match lines like:  `  toolset_subset:` followed by indented `- foo` lines
  const blockRe = new RegExp(`^[ \\t]*${key}:[ \\t]*\\r?\\n((?:[ \\t]+-[^\\n]*\\r?\\n?)+)`, 'm');
  const block = fm.match(blockRe);
  if (!block) return [];
  return block[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/^[ \t]+-[ \t]*/, '').trim())
    .filter(Boolean);
}

function diff(label: string, a: readonly string[], b: readonly string[]): string[] {
  const sa = new Set(a);
  const sb = new Set(b);
  const lines: string[] = [];
  for (const name of a) if (!sb.has(name)) lines.push(`  - in ${label}.left, not in right: ${name}`);
  for (const name of b) if (!sa.has(name)) lines.push(`  - in right, not in ${label}.left: ${name}`);
  return lines;
}

function main(): void {
  const manifest = loadManifest();
  const manifestSubset = manifest.mcp?.tool_subset ?? [];
  const manifestExcluded = manifest.mcp?.tool_subset_excluded ?? [];
  const skillSubset = loadSkillMdSubset('toolset_subset');
  const skillExcluded = loadSkillMdSubset('toolset_excluded');

  const errors: string[] = [];

  // 1. Runtime SUBSET vs manifest.subset
  const d1 = diff('TOOLSET_SUBSET vs manifest', TOOLSET_SUBSET, manifestSubset);
  if (d1.length > 0) {
    errors.push('TOOLSET_SUBSET (src/index.ts) <> manifest.json#mcp.tool_subset:');
    errors.push(...d1);
  }

  // 2. Runtime SUBSET vs SKILL.md subset
  const d2 = diff('TOOLSET_SUBSET vs SKILL.md', TOOLSET_SUBSET, skillSubset);
  if (d2.length > 0) {
    errors.push('TOOLSET_SUBSET (src/index.ts) <> SKILL.md#mcp.toolset_subset:');
    errors.push(...d2);
  }

  // 3. Runtime EXCLUDED vs manifest.excluded
  const d3 = diff('TOOLSET_EXCLUDED vs manifest', TOOLSET_EXCLUDED, manifestExcluded);
  if (d3.length > 0) {
    errors.push('TOOLSET_EXCLUDED (src/index.ts) <> manifest.json#mcp.tool_subset_excluded:');
    errors.push(...d3);
  }

  // 4. Runtime EXCLUDED vs SKILL.md excluded
  const d4 = diff('TOOLSET_EXCLUDED vs SKILL.md', TOOLSET_EXCLUDED, skillExcluded);
  if (d4.length > 0) {
    errors.push('TOOLSET_EXCLUDED (src/index.ts) <> SKILL.md#mcp.toolset_excluded:');
    errors.push(...d4);
  }

  // 5. manifest.tools[] vs subset (tools advertised must be subset)
  const advertised = (manifest.tools ?? []).map((t) => t.name);
  const d5 = diff('manifest.tools[] vs TOOLSET_SUBSET', advertised, TOOLSET_SUBSET);
  if (d5.length > 0) {
    errors.push('manifest.json#tools[] <> TOOLSET_SUBSET (advertised must equal subset):');
    errors.push(...d5);
  }

  // 6. Subset vs upstream descriptors
  const upstream = new Set(TOOL_DESCRIPTORS.map((d) => d.name));
  const missingUpstream = TOOLSET_SUBSET.filter((name) => !upstream.has(name));
  if (missingUpstream.length > 0) {
    errors.push('TOOLSET_SUBSET references tools missing from upstream @muhaven/mcp:');
    for (const name of missingUpstream) errors.push(`  - ${name}`);
  }

  // 7. Subset and excluded are disjoint
  const overlap = TOOLSET_SUBSET.filter((name) =>
    (TOOLSET_EXCLUDED as readonly string[]).includes(name),
  );
  if (overlap.length > 0) {
    errors.push('TOOLSET_SUBSET overlaps TOOLSET_EXCLUDED:');
    for (const name of overlap) errors.push(`  - ${name}`);
  }

  // 8. Subset ∪ Excluded covers every position.* + policy.* + read.* tool
  // upstream — drift here means a new upstream tool was added and the
  // skill hasn't decided whether to expose it.
  const upstreamCoverable = TOOL_DESCRIPTORS.map((d) => d.name);
  const partition = new Set([
    ...TOOLSET_SUBSET,
    ...TOOLSET_EXCLUDED,
  ]);
  const undecided = upstreamCoverable.filter((name) => !partition.has(name));
  if (undecided.length > 0) {
    errors.push(
      'Upstream tool added without an OpenClaw decision (must add to subset or excluded):',
    );
    for (const name of undecided) errors.push(`  - ${name}`);
  }

  // 9. bundled_version triple-match: manifest.mcp.bundled_version =
  //    SKILL.md frontmatter mcp.bundled_version = packages/mcp/package.json#version.
  //    The CI publish workflow enforces (1)+(3); enforcing it locally too
  //    catches the skew before tag-push so the operator doesn't bounce off
  //    the CI gate on a 20-minute publish run.
  const manifestBundled = manifest.mcp?.bundled_version;
  const skillMdBundled = loadSkillMdBundledVersion();
  const mcpPkgVersion = loadMcpPackageVersion();
  if (!manifestBundled) {
    errors.push(
      `manifest.json#mcp.bundled_version is missing — must equal packages/mcp/package.json#version (${mcpPkgVersion}); the openclaw-skill-publish.yml workflow's version-match step will fail on tag-push without it.`,
    );
  }
  if (!skillMdBundled) {
    errors.push(
      `SKILL.md frontmatter is missing the mcp.bundled_version key — must equal packages/mcp/package.json#version (${mcpPkgVersion}).`,
    );
  }
  if (
    manifestBundled &&
    skillMdBundled &&
    !(manifestBundled === skillMdBundled && skillMdBundled === mcpPkgVersion)
  ) {
    errors.push('bundled_version triple-match drift:');
    errors.push(`  - manifest.json#mcp.bundled_version       = ${manifestBundled}`);
    errors.push(`  - SKILL.md#mcp.bundled_version            = ${skillMdBundled}`);
    errors.push(`  - packages/mcp/package.json#version       = ${mcpPkgVersion}`);
    errors.push('  All three MUST match (pnpm pack rewrites workspace:* to the live version).');
  }

  if (errors.length > 0) {
    process.stderr.write(
      'verify-subset: FAIL — manifest / SKILL.md / runtime / upstream are inconsistent.\n\n',
    );
    process.stderr.write(errors.join('\n') + '\n');
    process.exit(70);
  }

  process.stdout.write(
    `verify-subset: OK — ${TOOLSET_SUBSET.length} tools advertised, ${TOOLSET_EXCLUDED.length} explicitly excluded, ` +
      `${TOOL_DESCRIPTORS.length} upstream; bundled @muhaven/mcp pinned at ${mcpPkgVersion} (matched across manifest.json + SKILL.md + packages/mcp/package.json).\n`,
  );
}

main();
