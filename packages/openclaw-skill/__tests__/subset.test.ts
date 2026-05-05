import { describe, expect, it } from 'vitest';
import { fullToolRegistry, TOOL_DESCRIPTORS } from '@muhaven/mcp';
import {
  selectOpenClawSubsetRegistry,
  TOOLSET_EXCLUDED,
  TOOLSET_SUBSET,
} from '../src/index.js';

describe('selectOpenClawSubsetRegistry', () => {
  it('exposes exactly the tools listed in TOOLSET_SUBSET', () => {
    const subset = selectOpenClawSubsetRegistry(fullToolRegistry());
    const names = subset.map((e) => e.descriptor.name).sort();
    expect(names).toEqual([...TOOLSET_SUBSET].sort());
  });

  it('excludes every tool listed in TOOLSET_EXCLUDED', () => {
    const subset = selectOpenClawSubsetRegistry(fullToolRegistry());
    const names = new Set(subset.map((e) => e.descriptor.name));
    for (const excluded of TOOLSET_EXCLUDED) {
      expect(names.has(excluded)).toBe(false);
    }
  });

  it('throws when an upstream tool the subset depends on is missing', () => {
    // Drop muhaven.position.buy from the upstream registry.
    const stripped = fullToolRegistry().filter(
      (e) => e.descriptor.name !== 'muhaven.position.buy',
    );
    expect(() => selectOpenClawSubsetRegistry(stripped)).toThrow(/tool-subset drift/);
  });

  it('passes through cleanly when upstream is already read-only-narrowed', () => {
    // Simulate the upstream `--read-only` filter — only read.* tools.
    const readOnly = fullToolRegistry().filter((e) => e.descriptor.group === 'read');
    const subset = selectOpenClawSubsetRegistry(readOnly);
    const names = subset.map((e) => e.descriptor.name).sort();
    // Should be the intersection of (TOOLSET_SUBSET ∩ read.*).
    const expected = TOOLSET_SUBSET.filter((name) =>
      readOnly.some((e) => e.descriptor.name === name),
    ).sort();
    expect(names).toEqual(expected);
  });

  it('returns the same descriptor objects (no mutation)', () => {
    const upstream = fullToolRegistry();
    const subset = selectOpenClawSubsetRegistry(upstream);
    for (const entry of subset) {
      const upstreamMatch = upstream.find((u) => u.descriptor.name === entry.descriptor.name);
      expect(upstreamMatch?.descriptor).toBe(entry.descriptor);
    }
  });
});

describe('OpenClaw subset partition invariants', () => {
  it('TOOLSET_SUBSET ∩ TOOLSET_EXCLUDED is empty', () => {
    const sub = new Set(TOOLSET_SUBSET);
    for (const e of TOOLSET_EXCLUDED) expect(sub.has(e)).toBe(false);
  });

  it('TOOLSET_SUBSET ∪ TOOLSET_EXCLUDED covers every upstream tool', () => {
    const partition = new Set([...TOOLSET_SUBSET, ...TOOLSET_EXCLUDED]);
    for (const d of TOOL_DESCRIPTORS) {
      expect(partition.has(d.name)).toBe(true);
    }
  });

  it('every TOOLSET_SUBSET name is a valid upstream tool', () => {
    const upstream = new Set(TOOL_DESCRIPTORS.map((d) => d.name));
    for (const name of TOOLSET_SUBSET) expect(upstream.has(name)).toBe(true);
  });

  it('every TOOLSET_EXCLUDED name is a valid upstream tool', () => {
    const upstream = new Set(TOOL_DESCRIPTORS.map((d) => d.name));
    for (const name of TOOLSET_EXCLUDED) expect(upstream.has(name)).toBe(true);
  });
});
