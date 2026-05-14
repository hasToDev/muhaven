import { describe, expect, it } from 'vitest';
import { parseLoginFlags } from '../src/broker/cli.js';

describe('parseLoginFlags', () => {
  it('returns the default shape for an empty argv', () => {
    const flags = parseLoginFlags([]);
    expect(flags).toEqual({
      noLaunchBrowser: false,
      brokerEndpoint: undefined,
      backendBaseUrl: undefined,
      dashboardBaseUrl: undefined,
      fromDaemon: false,
    });
  });

  it('parses --from-daemon as a boolean flag', () => {
    const flags = parseLoginFlags(['--from-daemon']);
    expect(flags.fromDaemon).toBe(true);
  });

  it('parses --no-launch-browser as a boolean flag', () => {
    const flags = parseLoginFlags(['--no-launch-browser']);
    expect(flags.noLaunchBrowser).toBe(true);
  });

  it('parses --broker-endpoint with its value argument', () => {
    const flags = parseLoginFlags(['--broker-endpoint', '/tmp/muhaven.sock']);
    expect(flags.brokerEndpoint).toBe('/tmp/muhaven.sock');
  });

  it('parses --backend-base-url + --dashboard-base-url together', () => {
    const flags = parseLoginFlags([
      '--backend-base-url',
      'https://api.example.test',
      '--dashboard-base-url',
      'https://dash.example.test',
    ]);
    expect(flags.backendBaseUrl).toBe('https://api.example.test');
    expect(flags.dashboardBaseUrl).toBe('https://dash.example.test');
  });

  it('rejects --from-daemon combined with --backend-base-url', () => {
    expect(() =>
      parseLoginFlags(['--from-daemon', '--backend-base-url', 'https://api.example.test']),
    ).toThrow(/mutually exclusive/);
  });

  it('rejects --from-daemon combined with --dashboard-base-url', () => {
    expect(() =>
      parseLoginFlags(['--from-daemon', '--dashboard-base-url', 'https://dash.example.test']),
    ).toThrow(/mutually exclusive/);
  });

  it('rejects unknown flags', () => {
    expect(() => parseLoginFlags(['--bogus'])).toThrow(/unknown flag/);
  });

  it('accepts --broker-endpoint with --from-daemon (orthogonal flags)', () => {
    const flags = parseLoginFlags(['--from-daemon', '--broker-endpoint', '/tmp/x.sock']);
    expect(flags.fromDaemon).toBe(true);
    expect(flags.brokerEndpoint).toBe('/tmp/x.sock');
  });
});
