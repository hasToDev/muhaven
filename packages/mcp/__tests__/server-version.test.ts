import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SERVER_VERSION } from '../src/server.js';

const pkgPath = join(__dirname, '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
  name: string;
  version: string;
};

describe('SERVER_VERSION', () => {
  it('resolves to package.json#version when imported unbundled (vitest path)', () => {
    // Vitest imports src/server.ts directly — __SERVER_VERSION__ is
    // undefined in this path, so the fallback `readFileSync('../package.json')`
    // wins. Asserting equality enforces that the fallback stays correct
    // (not just a hardcoded placeholder).
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  it('matches the published manifest.json#version', () => {
    // Cross-check: the manifest version must equal the package version
    // so MCPB host install dialogs surface the same string the LLM sees
    // in serverInfo.version.
    const manifest = JSON.parse(
      readFileSync(join(__dirname, '..', 'manifest.json'), 'utf-8'),
    ) as { version: string };
    expect(manifest.version).toBe(pkg.version);
    expect(SERVER_VERSION).toBe(manifest.version);
  });
});
