/**
 * Wave 5 Slice 2c — unit tests for the `muhaven-reinvest` poll loop
 * (`src/reinvest/runner.ts`). The batch executor is INJECTED (fake) so
 * these exercise the gating / buy-sizing / dedup / audit wiring without a
 * full UserOp build (that's covered by `reinvest-execute.test.ts`).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReinvestRunner, type ReinvestRunnerDeps } from '../src/reinvest/runner.js';
import type { ReinvestRuntimeConfig } from '../src/reinvest/config.js';
import type { ReinvestBatchResult } from '../src/reinvest/execute.js';
import type { BrokerClient } from '../src/clients/broker-client.js';
import type { BundlerClient } from '../src/clients/bundler-client.js';
import type { BackendClient } from '../src/clients/backend-client.js';

const TOKEN = ('0x' + '4'.repeat(40)) as `0x${string}`;
const SNAPSHOT_ADDR = ('0x' + '3'.repeat(40)) as `0x${string}`;
const SUBSCRIPTION = ('0x' + '2'.repeat(40)) as `0x${string}`;
const OK_RESULT: ReinvestBatchResult = {
  kind: 'ok',
  userOpHash: ('0x' + 'a'.repeat(64)) as `0x${string}`,
  txHash: ('0x' + 'd'.repeat(64)) as `0x${string}`,
  buyShares: 1n,
};

function makeConfig(over: { bundler?: boolean; budgetUsd6?: bigint; cooldownMs?: number } = {}): ReinvestRuntimeConfig {
  return {
    mcp: {
      backendBaseUrl: 'https://api.muhaven.app',
      dashboardBaseUrl: 'https://muhaven.app',
      brokerEndpoint: '/tmp/broker.sock',
      readOnly: false,
      requestTimeoutMs: 15_000,
      brokerTimeoutMs: 5_000,
      allowedBackendHosts: ['api.muhaven.app'],
      jwtCacheTtlSec: 30,
      bundlerUrl: over.bundler === false ? undefined : 'https://bundler.example',
      bundlerTimeoutMs: 20_000,
      chainId: 421614,
      subscriptionAddress: SUBSCRIPTION,
      entryPointAddress: ('0x' + '7'.repeat(40)) as `0x${string}`,
    },
    budgetUsd6: over.budgetUsd6 ?? 1_000_000n,
    pollIntervalMs: 300_000,
    cooldownMs: over.cooldownMs ?? 1_800_000,
    pidFilePath: '/tmp/reinvest.pid',
  };
}

interface StubBackends {
  shouldRun?: { shouldRun: boolean; epochs: unknown[]; reason?: string };
  nav?: string | null;
  /** Catalog's yield_snapshot_address for the token (cross-check source). */
  catalogSnapshot?: string;
}
function stubBackend(over: StubBackends = {}): { backend: BackendClient; post: ReturnType<typeof vi.fn> } {
  const post = vi.fn().mockResolvedValue({ recorded: true });
  const backend = {
    get: vi.fn().mockImplementation(async (path: string) => {
      if (path === '/api/v1/agent/reinvest/should-run') {
        return (
          over.shouldRun ?? {
            shouldRun: true,
            epochs: [{ token: TOKEN, snapshotAddress: SNAPSHOT_ADDR, epochId: '6', ratePerShare: '1000000' }],
          }
        );
      }
      throw new Error(`unstubbed get ${path}`);
    }),
    getUnauth: vi.fn().mockImplementation(async (path: string) => {
      if (path === '/api/v1/tokens') {
        return {
          tokens: [
            {
              address: TOKEN,
              symbol: 'CETES',
              latest_nav: over.nav === null ? null : { nav: over.nav ?? '1' },
              ...(over.catalogSnapshot ? { yield_snapshot_address: over.catalogSnapshot } : {}),
            },
          ],
        };
      }
      throw new Error(`unstubbed getUnauth ${path}`);
    }),
    post,
  } as unknown as BackendClient;
  return { backend, post };
}

function stubBroker(jwt: string | null = 'jwt.token.here'): BrokerClient {
  return {
    getJwt: vi.fn().mockResolvedValue({ type: 'get_jwt', jwt, expiresAtSec: null }),
  } as unknown as BrokerClient;
}

function makeRunner(
  over: {
    config?: ReinvestRuntimeConfig;
    broker?: BrokerClient;
    bundler?: BundlerClient | undefined;
    backend?: BackendClient;
    executeBatch?: ReinvestRunnerDeps['executeBatch'];
    now?: () => number;
  } = {},
): { runner: ReinvestRunner; execFake: ReturnType<typeof vi.fn> } {
  const execFake = vi.fn().mockResolvedValue(OK_RESULT);
  const runner = new ReinvestRunner({
    config: over.config ?? makeConfig(),
    broker: over.broker ?? stubBroker(),
    bundler: 'bundler' in over ? over.bundler : ({} as BundlerClient),
    backend: over.backend ?? stubBackend().backend,
    executeBatch: over.executeBatch ?? execFake,
    makeCycleId: () => '11111111-2222-4333-8444-555555555555',
    now: over.now ?? (() => 1_000_000),
    logger: () => {},
  });
  return { runner, execFake };
}

describe('ReinvestRunner.runCycle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('idles (no backend call) when Path D is not configured (no bundler)', async () => {
    const { backend } = stubBackend();
    const { runner, execFake } = makeRunner({ config: makeConfig({ bundler: false }), bundler: undefined, backend });
    await runner.runCycle();
    expect(backend.get).not.toHaveBeenCalled();
    expect(execFake).not.toHaveBeenCalled();
  });

  it('idles when the broker has no JWT (logged out)', async () => {
    const { backend } = stubBackend();
    const { runner, execFake } = makeRunner({ broker: stubBroker(null), backend });
    await runner.runCycle();
    expect(backend.get).not.toHaveBeenCalled();
    expect(execFake).not.toHaveBeenCalled();
  });

  it('does nothing when the gate is closed', async () => {
    const { backend } = stubBackend({ shouldRun: { shouldRun: false, epochs: [], reason: 'reinvest_disabled' } });
    const { runner, execFake } = makeRunner({ backend });
    await runner.runCycle();
    expect(execFake).not.toHaveBeenCalled();
  });

  it('executes the batch + records the audit on a green gate', async () => {
    const { backend, post } = stubBackend();
    const { runner, execFake } = makeRunner({ backend });
    await runner.runCycle();
    expect(execFake).toHaveBeenCalledTimes(1);
    const input = execFake.mock.calls[0][0];
    expect(input.epochId).toBe(6n);
    expect(input.requestedShares).toBe(1n); // $1 budget / $1 NAV = 1 share
    expect(input.tokenSymbol).toBe('CETES');
    // Audit recorded with the on-chain txHash.
    expect(post).toHaveBeenCalledWith(
      '/api/v1/agent/reinvest/cycle',
      expect.objectContaining({
        epochId: '6',
        tokenAddress: TOKEN.toLowerCase(),
        userOpHash: OK_RESULT.userOpHash,
        txHash: OK_RESULT.kind === 'ok' ? OK_RESULT.txHash : undefined,
        buyShares: '1',
      }),
    );
  });

  it('dedups on (token, epoch) within the cooldown window', async () => {
    const { backend } = stubBackend();
    const { runner, execFake } = makeRunner({ backend });
    await runner.runCycle();
    await runner.runCycle(); // same now() → still within cooldown
    expect(execFake).toHaveBeenCalledTimes(1);
  });

  it('does NOT set a cooldown or record audit when the batch SKIPS', async () => {
    const { backend, post } = stubBackend();
    const skip = vi.fn().mockResolvedValue({ kind: 'skip', reason: 'validator_not_enabled', message: 'pending' });
    const { runner } = makeRunner({ backend, executeBatch: skip });
    await runner.runCycle();
    await runner.runCycle();
    expect(skip).toHaveBeenCalledTimes(2); // retried — no cooldown
    expect(post).not.toHaveBeenCalled();
  });

  it('records audit WITHOUT txHash on submitted_no_receipt + sets cooldown', async () => {
    const { backend, post } = stubBackend();
    const submitted = vi
      .fn()
      .mockResolvedValue({ kind: 'submitted_no_receipt', userOpHash: ('0x' + 'b'.repeat(64)) as `0x${string}`, buyShares: 1n });
    const { runner } = makeRunner({ backend, executeBatch: submitted });
    await runner.runCycle();
    expect(post).toHaveBeenCalledTimes(1);
    const body = post.mock.calls[0][1];
    expect(body).not.toHaveProperty('txHash');
    await runner.runCycle(); // cooldown holds
    expect(submitted).toHaveBeenCalledTimes(1);
  });

  it('skips an epoch with no NAV (cannot size the buy)', async () => {
    const { backend } = stubBackend({ nav: null });
    const { runner, execFake } = makeRunner({ backend });
    await runner.runCycle();
    expect(execFake).not.toHaveBeenCalled();
  });

  it('skips an epoch when the budget converts to < 1 share at the current NAV', async () => {
    const { backend } = stubBackend({ nav: '1000000' }); // NAV $1M, budget $1 → 0 shares
    const { runner, execFake } = makeRunner({ backend });
    await runner.runCycle();
    expect(execFake).not.toHaveBeenCalled();
  });

  it('skips an epoch when the catalog snapshot disagrees with the gate snapshot (pairing guard)', async () => {
    const { backend } = stubBackend({ catalogSnapshot: '0x' + '9'.repeat(40) }); // ≠ gate's SNAPSHOT_ADDR
    const { runner, execFake } = makeRunner({ backend });
    await runner.runCycle();
    expect(execFake).not.toHaveBeenCalled();
  });

  it('proceeds when the catalog snapshot MATCHES the gate snapshot', async () => {
    const { backend } = stubBackend({ catalogSnapshot: SNAPSHOT_ADDR });
    const { runner, execFake } = makeRunner({ backend });
    await runner.runCycle();
    expect(execFake).toHaveBeenCalledTimes(1);
  });
});
