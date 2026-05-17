import { describe, it, expect } from 'vitest';
import {
  fullToolRegistry,
  registryForReadOnly,
  selectRegistry,
} from '../src/tools/registry.js';

describe('tool registry', () => {
  // Wave 4 surface evolution:
  //  - P3 shipped 13 tools (5 read + 4 position + 4 policy)
  //  - P7 added 5 issuer tools  → 18
  //  - P11 added 2 read + 2 governance → 22
  //  - 0.1.7 (Path C) added 1 cash tool (cash.wrap) → 23
  it('full registry contains all 23 tools (P3 + P7 + P11 + Path C)', () => {
    expect(fullToolRegistry().length).toBe(23);
  });

  it('read-only filter exposes 7 read.* tools only (5 P3 + 2 P11)', () => {
    const ro = registryForReadOnly();
    expect(ro.length).toBe(7);
    for (const e of ro) expect(e.descriptor.group).toBe('read');
  });

  it('selectRegistry(false) === full', () => {
    expect(selectRegistry(false).length).toBe(23);
  });

  it('selectRegistry(true) === read-only', () => {
    expect(selectRegistry(true).length).toBe(7);
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

  it('governance group (P11) has 2 sensitive=true propose tools', () => {
    const gov = fullToolRegistry().filter(
      (e) => e.descriptor.group === 'governance',
    );
    expect(gov.length).toBe(2);
    expect(gov.every((e) => e.descriptor.sensitive)).toBe(true);
    expect(gov.map((e) => e.descriptor.name).sort()).toEqual([
      'muhaven.governance.cast_vote',
      'muhaven.governance.propose',
    ]);
  });

  it('P11 read tools (protection_coverage / kyc_attestation) are sensitive=false', () => {
    const reads = fullToolRegistry().filter(
      (e) =>
        e.descriptor.name === 'muhaven.read.protection_coverage' ||
        e.descriptor.name === 'muhaven.read.kyc_attestation',
    );
    expect(reads.length).toBe(2);
    expect(reads.every((e) => !e.descriptor.sensitive)).toBe(true);
  });
});
