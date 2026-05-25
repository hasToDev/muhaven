import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zEnvBool } from '../config.js';

/**
 * Regression coverage for `zEnvBool` — the robust env-boolean coercion that
 * replaces `z.coerce.boolean()` on YIELD_CRON_ENABLED + YIELD_CRON_DRY_RUN.
 *
 * Root bug (2026-05-25): `z.coerce.boolean()` is `Boolean(value)`, so the
 * STRING "false" coerces to `true` (non-empty strings are truthy). That made
 * `YIELD_CRON_DRY_RUN=false` stay in dry-run and `YIELD_CRON_ENABLED=false`
 * fail to disable the cron. These tests pin the corrected behavior.
 */
describe('zEnvBool — robust env boolean coercion', () => {
  it('parses the string "false" as false (the footgun this replaces)', () => {
    expect(zEnvBool(false).parse('false')).toBe(false);
    expect(zEnvBool(true).parse('false')).toBe(false);
  });

  it('parses the string "true" as true', () => {
    expect(zEnvBool(false).parse('true')).toBe(true);
    expect(zEnvBool(true).parse('true')).toBe(true);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(zEnvBool(true).parse('  FALSE ')).toBe(false);
    expect(zEnvBool(false).parse('True')).toBe(true);
  });

  it('accepts common spellings: 0/1, yes/no, on/off', () => {
    expect(zEnvBool(true).parse('0')).toBe(false);
    expect(zEnvBool(false).parse('1')).toBe(true);
    expect(zEnvBool(true).parse('no')).toBe(false);
    expect(zEnvBool(false).parse('yes')).toBe(true);
    expect(zEnvBool(true).parse('off')).toBe(false);
    expect(zEnvBool(false).parse('on')).toBe(true);
  });

  it('falls back to the default when unset or empty/blank', () => {
    expect(zEnvBool(false).parse(undefined)).toBe(false);
    expect(zEnvBool(true).parse(undefined)).toBe(true);
    expect(zEnvBool(false).parse('')).toBe(false);
    expect(zEnvBool(true).parse('   ')).toBe(true);
  });

  it('passes real booleans through unchanged', () => {
    expect(zEnvBool(false).parse(true)).toBe(true);
    expect(zEnvBool(true).parse(false)).toBe(false);
  });

  it('rejects an unrecognised string loudly (boot-fail rather than silent default)', () => {
    expect(() => zEnvBool(false).parse('maybe')).toThrow();
    expect(() => zEnvBool(false).parse('enabled')).toThrow();
  });

  it('documents the old z.coerce.boolean() bug it fixes', () => {
    // The exact footgun: the string "false" coerced to `true`.
    expect(z.coerce.boolean().parse('false')).toBe(true);
    // zEnvBool gets it right.
    expect(zEnvBool(false).parse('false')).toBe(false);
  });

  // FU-1 (Wave 5 W2) — YIELD_CRON_SNAPSHOT_FUNDING is zEnvBool(true): ON
  // by default, but an explicit `=false` actually rolls back to cap-based
  // funding (the whole point of using zEnvBool over z.coerce.boolean()).
  it('YIELD_CRON_SNAPSHOT_FUNDING: default on, "false" disables', () => {
    const flag = zEnvBool(true);
    expect(flag.parse(undefined)).toBe(true);
    expect(flag.parse('')).toBe(true);
    expect(flag.parse('false')).toBe(false);
    expect(flag.parse('off')).toBe(false);
    expect(flag.parse('true')).toBe(true);
  });
});
