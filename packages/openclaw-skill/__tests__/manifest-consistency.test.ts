import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const skillRoot = join(__dirname, '..');
const repoRoot = join(skillRoot, '..', '..');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function readSkillMdFrontmatter(): string {
  const raw = readFileSync(join(skillRoot, 'SKILL.md'), 'utf-8');
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) throw new Error('SKILL.md frontmatter not found');
  return fm[1];
}

function frontmatterField(fm: string, key: string): string | undefined {
  const re = new RegExp(`^[ \\t]*${key}:[ \\t]*["']?([^"'\\r\\n#]+?)["']?[ \\t]*(?:#.*)?$`, 'm');
  const m = fm.match(re);
  return m ? m[1].trim() : undefined;
}

describe('OpenClaw skill manifest/SKILL.md/config consistency', () => {
  const manifest = readJson<{
    version: string;
    mcp?: { bundled?: string; bundled_version?: string };
  }>(join(skillRoot, 'manifest.json'));
  const pkg = readJson<{ version: string }>(join(skillRoot, 'package.json'));
  const config = readJson<{ version: string }>(join(skillRoot, 'config.json'));
  const mcpPkg = readJson<{ name: string; version: string }>(
    join(repoRoot, 'packages', 'mcp', 'package.json'),
  );
  const fm = readSkillMdFrontmatter();

  it('package.json + manifest.json + config.json + SKILL.md frontmatter share the same skill version', () => {
    const fmVersion = frontmatterField(fm, 'version');
    expect({
      pkg: pkg.version,
      manifest: manifest.version,
      config: config.version,
      skillMd: fmVersion,
    }).toEqual({
      pkg: pkg.version,
      manifest: pkg.version,
      config: pkg.version,
      skillMd: pkg.version,
    });
  });

  it('manifest.json#mcp.bundled_version equals SKILL.md mcp.bundled_version equals packages/mcp/package.json#version', () => {
    // Triple-match enforces the contract that `pnpm pack` rewrites
    // `workspace:*` → the live `@muhaven/mcp` version, which ClawHub
    // consumers will then resolve from npm. The CI publish workflow
    // (openclaw-skill-publish.yml "Version-match check" step) enforces
    // the manifest ↔ packages/mcp side; this test enforces it locally so
    // a tag-push doesn't fail 20 minutes into the publish run, AND it
    // also pulls SKILL.md into the gate (CI doesn't check that file).
    expect(manifest.mcp?.bundled_version, 'manifest.json#mcp.bundled_version').toBe(mcpPkg.version);
    expect(frontmatterField(fm, 'bundled_version'), 'SKILL.md mcp.bundled_version').toBe(
      mcpPkg.version,
    );
  });

  it('manifest.json#mcp.bundled identifies the upstream MCP package by name', () => {
    expect(manifest.mcp?.bundled).toBe(mcpPkg.name);
  });
});
