/**
 * Regression coverage for the 2026-05-23 schema-marshaling bug.
 *
 * `toJsonInputSchema` previously returned `{type:'object',
 * additionalProperties:false}` with NO `properties` field. Combined
 * with `additionalProperties:false`, JSON-Schema-compliant MCP hosts
 * (Claude Code's tool-call validator) interpret that as "no properties
 * allowed" and silently strip every argument before dispatch. The
 * operator's `Buy TBILL1 $1` smoke landed at the server as `{}`.
 *
 * These tests pin the contract: every tool advertised by the registry
 * MUST surface a `properties` block (when the underlying schema has
 * any fields), and `position.buy` specifically must expose both its
 * `token` and `amountUsdc` properties so deep-links resolve.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { toJsonInputSchema } from '../src/server.js';
import { selectRegistry } from '../src/tools/registry.js';
import {
  PositionBuyInputSchema,
  PolicySessionKeyStatusInputSchema,
} from '../src/tools/schemas.js';

describe('toJsonInputSchema', () => {
  it('emits a `properties` block for non-empty zod object schemas', () => {
    const out = toJsonInputSchema(PositionBuyInputSchema);
    expect(out.type).toBe('object');
    expect(out.properties).toBeTypeOf('object');
    expect(out.properties).not.toBeNull();
    // The actual fields the LLM needs to pass through must be present.
    expect((out.properties as Record<string, unknown>).token).toBeDefined();
    expect((out.properties as Record<string, unknown>).amountUsdc).toBeDefined();
  });

  it('preserves `additionalProperties: false` (strict mode)', () => {
    const out = toJsonInputSchema(PositionBuyInputSchema);
    expect(out.additionalProperties).toBe(false);
  });

  it('emits a `required` array listing non-optional fields', () => {
    const out = toJsonInputSchema(PositionBuyInputSchema);
    expect(Array.isArray(out.required)).toBe(true);
    const required = out.required as string[];
    expect(required).toContain('token');
    expect(required).toContain('amountUsdc');
  });

  it('omits `$schema` URL (host noise reduction)', () => {
    const out = toJsonInputSchema(PositionBuyInputSchema);
    expect(out).not.toHaveProperty('$schema');
  });

  it('handles empty-object schemas (e.g. policy.session_key_status) without throwing', () => {
    const out = toJsonInputSchema(PolicySessionKeyStatusInputSchema);
    expect(out.type).toBe('object');
    expect(out.additionalProperties).toBe(false);
    // No fields → either empty `properties` or `properties` absent;
    // both shapes are valid JSON Schema and both keep `required` empty
    // or absent. Either way, no host should fail to dispatch.
    const props = out.properties as Record<string, unknown> | undefined;
    if (props !== undefined) {
      expect(Object.keys(props)).toHaveLength(0);
    }
  });

  it('handles optional fields (regression — must NOT appear in `required`)', () => {
    const schema = z
      .object({
        a: z.string(),
        b: z.string().optional(),
      })
      .strict();
    const out = toJsonInputSchema(schema);
    expect((out.properties as Record<string, unknown>).a).toBeDefined();
    expect((out.properties as Record<string, unknown>).b).toBeDefined();
    expect(out.required).toEqual(['a']);
  });
});

describe('registry-wide contract — every tool exposes navigable input schema', () => {
  // selectRegistry({ readOnly: false }) returns the full set of tools.
  const registry = selectRegistry({ readOnly: false });

  for (const entry of registry) {
    it(`${entry.descriptor.name} surfaces a JSON Schema (no host-strip)`, () => {
      const out = toJsonInputSchema(entry.schema);
      expect(out.type).toBe('object');
      // additionalProperties MUST be present (matches the spirit of
      // our zod `.strict()` posture); MUST be explicitly false so the
      // host knows extras are forbidden — but if the schema has fields,
      // those MUST be navigable via `properties`.
      expect(out.additionalProperties).toBe(false);

      // Detect the 0.2.1 regression shape: object + additionalProperties=false
      // + no `properties` key + the underlying schema HAS fields. Any
      // tool matching that shape would land at the server as `{}` from
      // a strict host.
      const props = out.properties as Record<string, unknown> | undefined;
      const underlyingShape =
        (entry.schema as unknown as { _def: { shape?: () => Record<string, unknown> } })._def
          .shape;
      const hasFields =
        typeof underlyingShape === 'function'
          ? Object.keys(underlyingShape()).length > 0
          : false;

      if (hasFields) {
        expect(props, `${entry.descriptor.name} must expose a properties block`).toBeDefined();
        expect(Object.keys(props!).length).toBeGreaterThan(0);
      }
    });
  }

  // Nested-object defense — `zod-to-json-schema`'s `removeAdditionalStrategy:
  // 'strict'` option does NOT cascade `additionalProperties:false` down
  // to non-strict nested zod objects (verified empirically by Security
  // Engineer 2026-05-23). Today's only nested object
  // (`PositionRebalanceInputSchema.legs[]`) is `.strict()` so we're SAFE,
  // but a future contributor adding a nested object without `.strict()`
  // would silently emit `additionalProperties: true` in the host schema
  // (no security bypass — zod still rejects extras at parse — but
  // host-side validation becomes inconsistent with server-side). Walk
  // every emitted schema and assert the invariant recursively.
  function findNonStrictObjects(
    node: unknown,
    path: string,
  ): { path: string; reason: string }[] {
    const issues: { path: string; reason: string }[] = [];
    if (node === null || typeof node !== 'object') return issues;
    const obj = node as Record<string, unknown>;
    if (obj.type === 'object') {
      if (obj.additionalProperties !== false) {
        issues.push({
          path: path || '<root>',
          reason: `expected additionalProperties:false, got ${JSON.stringify(obj.additionalProperties)}`,
        });
      }
    }
    for (const [key, value] of Object.entries(obj)) {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          issues.push(...findNonStrictObjects(value[i], `${path}.${key}[${i}]`));
        }
      } else if (value !== null && typeof value === 'object') {
        issues.push(...findNonStrictObjects(value, `${path}.${key}`));
      }
    }
    return issues;
  }

  for (const entry of registry) {
    it(`${entry.descriptor.name} sets additionalProperties:false on every nested object`, () => {
      const out = toJsonInputSchema(entry.schema);
      const issues = findNonStrictObjects(out, '');
      expect(
        issues,
        `${entry.descriptor.name} has nested objects without additionalProperties:false. Add \`.strict()\` to those zod objects.\n${JSON.stringify(issues, null, 2)}`,
      ).toEqual([]);
    });
  }
});
