import { describe, expect, it } from 'vitest';
import { loadBrokerConfig, loadMcpConfig } from '../src/config.js';

describe('loadBrokerConfig', () => {
  const valid32Hex = ('0x' + '1'.repeat(64)) as `0x${string}`;

  it('returns sessionKeyHex=undefined when MUHAVEN_BROKER_SESSION_KEY is absent', () => {
    const cfg = loadBrokerConfig({});
    expect(cfg.sessionKeyHex).toBeUndefined();
    // Other invariants survive the read-only posture.
    expect(typeof cfg.endpoint).toBe('string');
    expect(cfg.endpoint.length).toBeGreaterThan(0);
    expect(cfg.maxRequestBytes).toBeGreaterThan(0);
    expect(cfg.requestTimeoutMs).toBeGreaterThan(0);
  });

  it('returns sessionKeyHex=undefined when MUHAVEN_BROKER_SESSION_KEY is the empty string', () => {
    const cfg = loadBrokerConfig({ MUHAVEN_BROKER_SESSION_KEY: '' });
    expect(cfg.sessionKeyHex).toBeUndefined();
  });

  it('returns the parsed sessionKeyHex when supplied', () => {
    const cfg = loadBrokerConfig({ MUHAVEN_BROKER_SESSION_KEY: valid32Hex });
    expect(cfg.sessionKeyHex).toBe(valid32Hex);
  });

  it('throws when MUHAVEN_BROKER_SESSION_KEY is present but malformed', () => {
    expect(() => loadBrokerConfig({ MUHAVEN_BROKER_SESSION_KEY: '0xdeadbeef' })).toThrow(
      /0x-prefixed 32-byte hex string/,
    );
  });

  it('surfaces backendBaseUrl + dashboardBaseUrl from env (or defaults)', () => {
    const cfg = loadBrokerConfig({});
    // Defaults — these are the published prod hosts.
    expect(cfg.backendBaseUrl).toBe('https://api.muhaven.app');
    expect(cfg.dashboardBaseUrl).toBe('https://muhaven.app');

    const overridden = loadBrokerConfig({
      MUHAVEN_BACKEND_URL: 'https://api-stage.muhaven.app/',
      MUHAVEN_DASHBOARD_URL: 'https://stage.muhaven.app',
    });
    // Trailing slash stripped on backend; dashboard left alone.
    expect(overridden.backendBaseUrl).toBe('https://api-stage.muhaven.app');
    expect(overridden.dashboardBaseUrl).toBe('https://stage.muhaven.app');
  });
});

describe('loadMcpConfig (sanity smoke after config refactor)', () => {
  it('still returns shape-compatible defaults', () => {
    const cfg = loadMcpConfig({});
    expect(cfg.backendBaseUrl).toBe('https://api.muhaven.app');
    expect(cfg.dashboardBaseUrl).toBe('https://muhaven.app');
    expect(typeof cfg.brokerEndpoint).toBe('string');
    expect(cfg.readOnly).toBe(false);
  });
});
