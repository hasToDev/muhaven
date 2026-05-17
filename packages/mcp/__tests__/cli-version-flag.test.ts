import { describe, expect, it } from 'vitest';
import { getBrokerPackageVersion, runCli } from '../src/broker/cli.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

describe('getBrokerPackageVersion', () => {
  it('returns the package.json#version (non-empty, semver-shaped)', () => {
    const v = getBrokerPackageVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('matches packages/mcp/package.json#version exactly', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'),
    ) as { version: string };
    expect(getBrokerPackageVersion()).toBe(pkg.version);
  });
});

describe('runCli --version / -v', () => {
  it('returns 0 + prints "muhaven-broker @muhaven/mcp@<version>" on --version', async () => {
    const stdout: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runCli(['--version']);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = origWrite;
    }
    const out = stdout.join('');
    expect(out).toMatch(/^muhaven-broker @muhaven\/mcp@\d+\.\d+\.\d+/);
  });

  it('returns 0 + same output on -v short flag', async () => {
    const stdout: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runCli(['-v']);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = origWrite;
    }
    const out = stdout.join('');
    expect(out).toMatch(/^muhaven-broker @muhaven\/mcp@/);
  });

  it('prints the usage block on --help', async () => {
    const stdout: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runCli(['--help']);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = origWrite;
    }
    const out = stdout.join('');
    expect(out).toMatch(/usage: muhaven-broker/);
    expect(out).toMatch(/setup\s+One-shot install/);
    expect(out).toMatch(/--version\s+Print the @muhaven\/mcp package version/);
  });
});
