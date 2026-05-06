import { describe, it, expect } from 'vitest';
import {
  fullToolRegistry,
  registryForReadOnly,
  selectRegistry,
} from '../src/tools/registry.js';

describe('tool registry', () => {
  // Wave 4 P7 expanded the surface from 13 to 18 (5 issuer tools added).
  it('full registry contains all 18 tools (13 P3 + 5 P7 issuer)', () => {
    expect(fullToolRegistry().length).toBe(18);
  });

  it('read-only filter exposes 5 read.* tools only', () => {
    const ro = registryForReadOnly();
    expect(ro.length).toBe(5);
    for (const e of ro) expect(e.descriptor.group).toBe('read');
  });

  it('selectRegistry(false) === full', () => {
    expect(selectRegistry(false).length).toBe(18);
  });

  it('selectRegistry(true) === read-only', () => {
    expect(selectRegistry(true).length).toBe(5);
  });

  it('every entry has a schema with .parse', () => {
    for (const e of fullToolRegistry()) {
      expect(typeof e.schema.parse).toBe('function');
    }
  });

  it('issuer group has 5 tools, all sensitive=true except audit_query', () => {
    const issuer = fullToolRegistry().filter(
      (e) => e.descriptor.group === 'issuer',
    );
    expect(issuer.length).toBe(5);
    const auditQuery = issuer.find((e) => e.descriptor.name.endsWith('audit_query'));
    expect(auditQuery?.descriptor.sensitive).toBe(false);
    const writes = issuer.filter((e) => !e.descriptor.name.endsWith('audit_query'));
    expect(writes.every((e) => e.descriptor.sensitive)).toBe(true);
  });
});
