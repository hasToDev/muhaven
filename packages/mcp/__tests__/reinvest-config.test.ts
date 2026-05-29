/**
 * Wave 5 Slice 2c — `loadReinvestConfig` / `isReinvestExecutable` parsing.
 */

import { describe, it, expect } from 'vitest';
import { loadReinvestConfig, isReinvestExecutable } from '../src/reinvest/config.js';

const BASE = {
  MUHAVEN_BACKEND_URL: 'https://api.muhaven.app',
  MUHAVEN_DASHBOARD_URL: 'https://muhaven.app',
  MUHAVEN_BUNDLER_URL: 'https://bundler.example',
  MUHAVEN_SUBSCRIPTION_ADDRESS: '0x' + '2'.repeat(40),
} as NodeJS.ProcessEnv;

describe('loadReinvestConfig', () => {
  it('defaults the budget to $1 (1_000_000 usd6)', () => {
    const cfg = loadReinvestConfig({ ...BASE });
    expect(cfg.budgetUsd6).toBe(1_000_000n);
    expect(cfg.pollIntervalMs).toBe(300_000);
    expect(cfg.cooldownMs).toBe(1_800_000);
  });

  it('parses a decimal budget', () => {
    const cfg = loadReinvestConfig({ ...BASE, MUHAVEN_REINVEST_BUDGET_USD: '2.5' });
    expect(cfg.budgetUsd6).toBe(2_500_000n);
  });

  it('rejects a non-numeric budget', () => {
    expect(() => loadReinvestConfig({ ...BASE, MUHAVEN_REINVEST_BUDGET_USD: 'abc' })).toThrow(
      /MUHAVEN_REINVEST_BUDGET_USD/,
    );
  });

  it('clamps the poll interval to a 30s floor', () => {
    const cfg = loadReinvestConfig({ ...BASE, MUHAVEN_REINVEST_POLL_INTERVAL_SEC: '5' });
    expect(cfg.pollIntervalMs).toBe(30_000);
  });

  it('honours a custom poll interval + cooldown', () => {
    const cfg = loadReinvestConfig({
      ...BASE,
      MUHAVEN_REINVEST_POLL_INTERVAL_SEC: '600',
      MUHAVEN_REINVEST_COOLDOWN_SEC: '120',
    });
    expect(cfg.pollIntervalMs).toBe(600_000);
    expect(cfg.cooldownMs).toBe(120_000);
  });
});

describe('isReinvestExecutable', () => {
  it('is executable with budget + bundler + subscription set', () => {
    expect(isReinvestExecutable(loadReinvestConfig({ ...BASE })).ok).toBe(true);
  });

  it('idles when the budget is 0', () => {
    const r = isReinvestExecutable(loadReinvestConfig({ ...BASE, MUHAVEN_REINVEST_BUDGET_USD: '0' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/budget disabled/);
  });

  it('idles when the bundler URL is unset (Path D off)', () => {
    const { MUHAVEN_BUNDLER_URL, ...noBundler } = BASE;
    void MUHAVEN_BUNDLER_URL;
    const r = isReinvestExecutable(loadReinvestConfig(noBundler));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/MUHAVEN_BUNDLER_URL/);
  });

  it('idles when the subscription address is unset', () => {
    const { MUHAVEN_SUBSCRIPTION_ADDRESS, ...noSub } = BASE;
    void MUHAVEN_SUBSCRIPTION_ADDRESS;
    const r = isReinvestExecutable(loadReinvestConfig(noSub));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/MUHAVEN_SUBSCRIPTION_ADDRESS/);
  });
});
