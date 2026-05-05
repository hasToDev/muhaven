import { describe, it, expect } from 'vitest';
import {
  fullToolRegistry,
  registryForReadOnly,
  selectRegistry,
} from '../src/tools/registry.js';

describe('tool registry', () => {
  it('full registry contains all 13 tools', () => {
    expect(fullToolRegistry().length).toBe(13);
  });

  it('read-only filter exposes 5 read.* tools only', () => {
    const ro = registryForReadOnly();
    expect(ro.length).toBe(5);
    for (const e of ro) expect(e.descriptor.group).toBe('read');
  });

  it('selectRegistry(false) === full', () => {
    expect(selectRegistry(false).length).toBe(13);
  });

  it('selectRegistry(true) === read-only', () => {
    expect(selectRegistry(true).length).toBe(5);
  });

  it('every entry has a schema with .parse', () => {
    for (const e of fullToolRegistry()) {
      expect(typeof e.schema.parse).toBe('function');
    }
  });
});
