import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

/**
 * FU-2 (Wave 5 W2) — source-scan regression guards. The footgun is
 * platform-wide: EVERY boolean env flag must use `zEnvBool(...)`, never
 * `z.coerce.boolean()` (where the string "false" silently coerces to `true`).
 * These read the config.ts source so a future flag that re-introduces
 * `z.coerce.boolean()` — or drops a known flag's conversion — boot-fails CI
 * here rather than silently shipping an undisable-able toggle to prod.
 */
describe('config.ts boolean-flag hygiene (FU-2)', () => {
  const CONFIG_SRC = readFileSync(
    fileURLToPath(new URL('../config.ts', import.meta.url)),
    'utf8',
  );

  // The full set of boolean env flags. W2 converted the first three; FU-2
  // converted the remaining eight. There should be no others.
  const BOOLEAN_FLAGS = [
    'YIELD_CRON_ENABLED',
    'YIELD_CRON_DRY_RUN',
    'YIELD_CRON_SNAPSHOT_FUNDING',
    'BLOCK_POLLER_ENABLED',
    'NAV_CRON_ENABLED',
    'TAX_EVENT_POLLER_ENABLED',
    'CHECKOUT_SETTLEMENT_POLLER_ENABLED',
    'PERMISSION_INSTALLED_POLLER_ENABLED',
    'VALIDATOR_ENABLE_WATCHDOG_ENABLED',
    'ISSUER_ONBOARDING_ENABLED',
    'AGENT_POLICY_CRON_ENABLED',
  ] as const;

  it('defines ZERO schema fields with z.coerce.boolean() (footgun eradicated)', () => {
    // Match only schema FIELD definitions (`<KEY>: z.coerce.boolean(`), so the
    // header comment's prose mention of `z.coerce.boolean()` doesn't count.
    // `z.coerce.number()` for numeric vars is intentionally allowed.
    const offenders = CONFIG_SRC.match(/^\s*\w+:\s*z\.coerce\.boolean\(/gm) ?? [];
    expect(offenders).toEqual([]);
  });

  it('defines every boolean flag with zEnvBool(...)', () => {
    for (const flag of BOOLEAN_FLAGS) {
      const re = new RegExp(`\\b${flag}:\\s*zEnvBool\\(`);
      expect(re.test(CONFIG_SRC), `${flag} must use zEnvBool(...)`).toBe(true);
    }
  });
});
