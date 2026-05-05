import { describe, it, expect } from 'vitest';
import {
  TOOL_DESCRIPTORS,
  hashToolDescriptor,
  buildToolHashTable,
  verifyDescriptorAgainstPin,
} from '../src/tools/descriptions.js';

describe('tool descriptors', () => {
  it('every name matches the muhaven.<group>.<verb> regex', () => {
    const re = /^muhaven\.[a-z]+\.[a-z][a-z0-9_]*$/;
    for (const t of TOOL_DESCRIPTORS) {
      expect(t.name, t.name).toMatch(re);
    }
  });

  it('no duplicates', () => {
    const set = new Set(TOOL_DESCRIPTORS.map((t) => t.name));
    expect(set.size).toBe(TOOL_DESCRIPTORS.length);
  });

  it('hash is deterministic', () => {
    const a = hashToolDescriptor(TOOL_DESCRIPTORS[0]);
    const b = hashToolDescriptor(TOOL_DESCRIPTORS[0]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('different descriptors hash differently', () => {
    const hashes = TOOL_DESCRIPTORS.map(hashToolDescriptor);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('buildToolHashTable returns one entry per descriptor', () => {
    const table = buildToolHashTable();
    expect(table.length).toBe(TOOL_DESCRIPTORS.length);
  });

  it('verifyDescriptorAgainstPin returns null on match, drift on mismatch', () => {
    const d = TOOL_DESCRIPTORS[0];
    const pin = hashToolDescriptor(d);
    expect(verifyDescriptorAgainstPin(d, pin)).toBeNull();
    const drift = verifyDescriptorAgainstPin(d, '0'.repeat(64));
    expect(drift).not.toBeNull();
    if (drift) expect(drift.liveSha256).toBe(pin);
  });

  it('matches the pinned tool-hashes.json', async () => {
    // Locate the file relative to this test (ESM resolution).
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const target = path.join(here, '..', 'tool-hashes.json');
    const raw = await fs.readFile(target, 'utf8');
    const pinned = JSON.parse(raw) as { tools: { name: string; sha256: string }[] };
    const map = new Map(pinned.tools.map((t) => [t.name, t.sha256]));
    for (const d of TOOL_DESCRIPTORS) {
      expect(hashToolDescriptor(d), `pinned hash for ${d.name}`).toBe(map.get(d.name));
    }
  });
});
