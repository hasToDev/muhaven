/**
 * Wave 4 P5 (Wave-5 buyer-side port, P2) — FundingPoller tests.
 *
 * The real poller uses a viem `PublicClient` against Arb Sepolia, but
 * the only surface it actually touches is `readContract({...balanceOf})`.
 * We inject a stub `publicClient` to drive a deterministic balance
 * sequence and assert: immediate-first-poll, single-shot onFunded,
 * stop semantics, in-flight overlap guard, RPC-error tolerance, and
 * restart cleanliness.
 *
 * Vitest fake timers + `advanceTimersByTimeAsync` give us a single
 * test fixture for "5 seconds elapse" without real sleeps.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FundingPoller } from '../src/funding-poll.js';

const BUYER = '0xb18ca2122b31Df9Aaef8226f6218Bd93B852F40A' as const;
const USDC = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d' as const;

/** Build a stub `PublicClient` whose `readContract` returns the
 *  sequence in order (last value is repeated if more polls happen).
 *  Entries that are `Error` instances are thrown instead of returned. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makePublicClient(responses: Array<bigint | Error>): any {
  let i = 0;
  return {
    readContract: vi.fn(async () => {
      const next =
        i < responses.length
          ? responses[i]
          : responses[responses.length - 1];
      i += 1;
      if (next instanceof Error) throw next;
      return next as bigint;
    }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FundingPoller', () => {
  it('runs an immediate poll on start before the first interval tick', async () => {
    const publicClient = makePublicClient([0n]);
    const onPoll = vi.fn();
    const onFunded = vi.fn();
    const poller = new FundingPoller({
      publicClient,
      usdcAddress: USDC,
      pollIntervalMs: 5_000,
      onFunded,
      onPoll,
    });
    poller.start(BUYER, 1_000_000n);
    // Flush the synchronous tick's microtasks — no real time passes.
    await vi.advanceTimersByTimeAsync(0);
    expect(publicClient.readContract).toHaveBeenCalledTimes(1);
    expect(publicClient.readContract).toHaveBeenCalledWith({
      address: USDC,
      // We don't assert the ABI shape verbatim — viem's `erc20Abi`
      // changes shape between minors. Function name + args are
      // enough to confirm the call.
      abi: expect.any(Array),
      functionName: 'balanceOf',
      args: [BUYER],
    });
    expect(onPoll).toHaveBeenCalledWith(0n);
    expect(onFunded).not.toHaveBeenCalled();
    expect(poller.isRunning).toBe(true);
    poller.stop();
  });

  it('fires onFunded exactly once when the balance crosses the threshold', async () => {
    const publicClient = makePublicClient([0n, 500_000n, 1_500_000n]);
    const onFunded = vi.fn();
    const poller = new FundingPoller({
      publicClient,
      usdcAddress: USDC,
      pollIntervalMs: 5_000,
      onFunded,
    });
    poller.start(BUYER, 1_000_000n);
    await vi.advanceTimersByTimeAsync(0); // tick 1: 0
    await vi.advanceTimersByTimeAsync(5_000); // tick 2: 500_000
    expect(onFunded).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000); // tick 3: 1_500_000 → fire
    expect(onFunded).toHaveBeenCalledTimes(1);
    expect(onFunded).toHaveBeenCalledWith(1_500_000n);
    expect(poller.isRunning).toBe(false);
  });

  it('fires onFunded only once even if subsequent ticks would also cross', async () => {
    const publicClient = makePublicClient([2_000_000n, 3_000_000n, 4_000_000n]);
    const onFunded = vi.fn();
    const poller = new FundingPoller({
      publicClient,
      usdcAddress: USDC,
      pollIntervalMs: 5_000,
      onFunded,
    });
    poller.start(BUYER, 1_000_000n);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onFunded).toHaveBeenCalledTimes(1);
    // After firing, the interval is cleared. RPC was hit only on the
    // immediate-first tick (no second tick was reached).
    expect(publicClient.readContract).toHaveBeenCalledTimes(1);
  });

  it('fires onFunded on the immediate-first tick if the kernel is pre-funded', async () => {
    const publicClient = makePublicClient([10_000_000n]);
    const onFunded = vi.fn();
    const poller = new FundingPoller({
      publicClient,
      usdcAddress: USDC,
      pollIntervalMs: 5_000,
      onFunded,
    });
    poller.start(BUYER, 1_000_000n);
    await vi.advanceTimersByTimeAsync(0);
    expect(onFunded).toHaveBeenCalledTimes(1);
    expect(onFunded).toHaveBeenCalledWith(10_000_000n);
    expect(poller.isRunning).toBe(false);
  });

  it('stops polling after stop()', async () => {
    const publicClient = makePublicClient([0n, 0n, 0n]);
    const onPoll = vi.fn();
    const onFunded = vi.fn();
    const poller = new FundingPoller({
      publicClient,
      usdcAddress: USDC,
      pollIntervalMs: 5_000,
      onFunded,
      onPoll,
    });
    poller.start(BUYER, 1_000_000n);
    await vi.advanceTimersByTimeAsync(0); // tick 1 — fires
    poller.stop();
    await vi.advanceTimersByTimeAsync(5_000); // no tick
    await vi.advanceTimersByTimeAsync(5_000); // no tick
    expect(publicClient.readContract).toHaveBeenCalledTimes(1);
    expect(onPoll).toHaveBeenCalledTimes(1);
    expect(onFunded).not.toHaveBeenCalled();
    expect(poller.isRunning).toBe(false);
  });

  it('surfaces RPC errors via onError and keeps polling', async () => {
    const publicClient = makePublicClient([
      new Error('rpc timeout'),
      2_000_000n,
    ]);
    const onFunded = vi.fn();
    const onError = vi.fn();
    const onPoll = vi.fn();
    const poller = new FundingPoller({
      publicClient,
      usdcAddress: USDC,
      pollIntervalMs: 5_000,
      onFunded,
      onError,
      onPoll,
    });
    poller.start(BUYER, 1_000_000n);
    await vi.advanceTimersByTimeAsync(0); // tick 1 throws
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onPoll).not.toHaveBeenCalled();
    expect(onFunded).not.toHaveBeenCalled();
    expect(poller.isRunning).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000); // tick 2 — fires
    expect(onPoll).toHaveBeenCalledWith(2_000_000n);
    expect(onFunded).toHaveBeenCalledWith(2_000_000n);
  });

  it('does not stack overlapping ticks when an RPC is slow (in-flight guard)', async () => {
    let resolveFirst!: (v: bigint) => void;
    const slowFirst = new Promise<bigint>((r) => {
      resolveFirst = r;
    });
    const publicClient = {
      readContract: vi
        .fn()
        .mockReturnValueOnce(slowFirst)
        .mockResolvedValue(0n),
    };
    const poller = new FundingPoller({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      publicClient: publicClient as any,
      usdcAddress: USDC,
      pollIntervalMs: 5_000,
      onFunded: vi.fn(),
    });
    poller.start(BUYER, 1_000_000n);
    // First tick fires (synchronous start) but is still resolving.
    // Advance past TWO interval boundaries — neither must spawn a
    // second readContract.
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(publicClient.readContract).toHaveBeenCalledTimes(1);
    // Interval is still alive (we didn't `stop()`); confirms the
    // guard suppresses overlapping ticks without breaking the loop.
    expect(poller.isRunning).toBe(true);
    // Resolve the first call; the next interval boundary now picks up.
    resolveFirst(0n);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(publicClient.readContract).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it('a stop() during in-flight RPC suppresses onFunded after the RPC resolves', async () => {
    let resolve!: (v: bigint) => void;
    const hang = new Promise<bigint>((r) => {
      resolve = r;
    });
    const publicClient = {
      readContract: vi.fn().mockReturnValue(hang),
    };
    const onFunded = vi.fn();
    const onPoll = vi.fn();
    const poller = new FundingPoller({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      publicClient: publicClient as any,
      usdcAddress: USDC,
      pollIntervalMs: 5_000,
      onFunded,
      onPoll,
    });
    poller.start(BUYER, 1_000_000n);
    // Stop while the first tick is mid-flight.
    poller.stop();
    // Now resolve the call with a balance above the threshold — the
    // post-await `stopped` check must suppress onPoll + onFunded.
    resolve(10_000_000n);
    await Promise.resolve();
    await Promise.resolve();
    expect(onPoll).not.toHaveBeenCalled();
    expect(onFunded).not.toHaveBeenCalled();
  });

  it('a stop() during in-flight RPC suppresses onError if the RPC then rejects', async () => {
    let reject!: (err: Error) => void;
    const hang = new Promise<bigint>((_resolve, rej) => {
      reject = rej;
    });
    const publicClient = {
      readContract: vi.fn().mockReturnValue(hang),
    };
    const onFunded = vi.fn();
    const onError = vi.fn();
    const poller = new FundingPoller({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      publicClient: publicClient as any,
      usdcAddress: USDC,
      pollIntervalMs: 5_000,
      onFunded,
      onError,
    });
    poller.start(BUYER, 1_000_000n);
    poller.stop();
    reject(new Error('rpc timed out after stop'));
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).not.toHaveBeenCalled();
    expect(onFunded).not.toHaveBeenCalled();
  });

  it('a slow RPC from a prior start() does not leak callbacks into the next start()', async () => {
    // Reproduces Code Reviewer findings #3/#4: stop()+start() with a
    // pending RPC from the prior run. The prior run's `readContract`
    // resolution (success OR error) must NOT fire onPoll/onFunded/
    // onError on the new run's callbacks.
    let resolveFirstRun!: (v: bigint) => void;
    const slowFirstRun = new Promise<bigint>((r) => {
      resolveFirstRun = r;
    });
    const publicClient = {
      readContract: vi
        .fn()
        .mockReturnValueOnce(slowFirstRun)
        .mockResolvedValue(0n),
    };
    const onFunded = vi.fn();
    const onPoll = vi.fn();
    const onError = vi.fn();
    const poller = new FundingPoller({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      publicClient: publicClient as any,
      usdcAddress: USDC,
      pollIntervalMs: 5_000,
      onFunded,
      onPoll,
      onError,
    });
    poller.start(BUYER, 1_000_000n);
    // First run's tick is mid-flight against `slowFirstRun`.
    poller.stop();
    // Start a fresh run BEFORE resolving the prior RPC.
    poller.start(BUYER, 1_000_000n);
    // Now resolve the prior run with a HUGE balance — without the
    // epoch guard, this would fire onPoll + onFunded against the new
    // run's callbacks. The epoch token suppresses it.
    resolveFirstRun(10_000_000n);
    await Promise.resolve();
    await Promise.resolve();
    // The new run's immediate tick has fired against the mocked 0n,
    // so onPoll WAS called for the new run with 0n — but NOT with
    // 10_000_000n from the prior run.
    for (const call of onPoll.mock.calls) {
      expect(call[0]).not.toBe(10_000_000n);
    }
    expect(onFunded).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    poller.stop();
  });

  it('restarts cleanly when start() is called twice without stop()', async () => {
    const publicClient = makePublicClient([0n, 0n, 0n]);
    const onFunded = vi.fn();
    const poller = new FundingPoller({
      publicClient,
      usdcAddress: USDC,
      pollIntervalMs: 5_000,
      onFunded,
    });
    poller.start(BUYER, 1_000_000n);
    await vi.advanceTimersByTimeAsync(0); // immediate tick #1
    // Second start() — should clear the prior interval, reset state,
    // and fire a new immediate tick. Only one setInterval is live.
    poller.start(BUYER, 2n);
    await vi.advanceTimersByTimeAsync(0); // immediate tick #2 of the second run
    expect(publicClient.readContract).toHaveBeenCalledTimes(2);
    // No double-firing on stale 0n response.
    expect(onFunded).not.toHaveBeenCalled();
    // Now advance one interval — the third call would return 0n
    // (per the makePublicClient sequence) but a balance < 2 still
    // doesn't trigger.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(publicClient.readContract).toHaveBeenCalledTimes(3);
    poller.stop();
  });

  it('a NEW run can make progress after a slow PRIOR-epoch RPC resolves (inFlight cleared)', async () => {
    // Self-review (post-62dbdcc) regression: prior to the unconditional
    // inFlight=false clear in tick()'s post-await branch, the inFlight
    // slot stayed STUCK true after a slow prior-epoch RPC resolved,
    // because the conditional clear (`if epoch === runEpoch`) refused
    // to touch the slot when the epoch had rolled. The new run's
    // ticks would forever short-circuit on the inFlight guard,
    // permanently wedging the page. This test pins the fix: after
    // the prior epoch's RPC settles, the new run's NEXT setInterval
    // tick must actually call readContract.
    let resolveFirstRun!: (v: bigint) => void;
    const slowFirstRun = new Promise<bigint>((r) => {
      resolveFirstRun = r;
    });
    const publicClient = {
      readContract: vi
        .fn()
        .mockReturnValueOnce(slowFirstRun)
        .mockResolvedValue(0n),
    };
    const onPoll = vi.fn();
    const poller = new FundingPoller({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      publicClient: publicClient as any,
      usdcAddress: USDC,
      pollIntervalMs: 5_000,
      onFunded: vi.fn(),
      onPoll,
    });
    poller.start(BUYER, 1_000_000n);
    // First run's tick is mid-flight against `slowFirstRun`.
    poller.stop();
    poller.start(BUYER, 1_000_000n);
    // The new run's immediate-first tick short-circuits because
    // inFlight is still true from the prior run's tick.
    await vi.advanceTimersByTimeAsync(0);
    expect(publicClient.readContract).toHaveBeenCalledTimes(1);
    // Resolve the prior run's RPC. With the fix, this unconditionally
    // clears inFlight, so the next interval-driven tick of the new
    // run will succeed. Without the fix, the new run's ticks stay
    // permanently short-circuited.
    resolveFirstRun(10_000_000n);
    await Promise.resolve();
    await Promise.resolve();
    expect(onPoll).not.toHaveBeenCalledWith(10_000_000n);
    // Advance one interval — the new run's next tick must fire.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(publicClient.readContract).toHaveBeenCalledTimes(2);
    expect(onPoll).toHaveBeenCalledWith(0n);
    poller.stop();
  });

  it('a rejection from a prior epoch does not fire onError on the new run', async () => {
    // Mirror of the success-leak case but for the error path. Same
    // failure mode reasoning: without the epoch token + unconditional
    // inFlight clear, a prior-epoch RPC rejection would either fire
    // onError against the new run's callbacks OR leave inFlight stuck
    // depending on the code path order. This test pins both halves.
    let rejectFirstRun!: (err: Error) => void;
    const slowFirstRun = new Promise<bigint>((_resolve, reject) => {
      rejectFirstRun = reject;
    });
    const publicClient = {
      readContract: vi
        .fn()
        .mockReturnValueOnce(slowFirstRun)
        .mockResolvedValue(0n),
    };
    const onError = vi.fn();
    const onPoll = vi.fn();
    const poller = new FundingPoller({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      publicClient: publicClient as any,
      usdcAddress: USDC,
      pollIntervalMs: 5_000,
      onFunded: vi.fn(),
      onError,
      onPoll,
    });
    poller.start(BUYER, 1_000_000n);
    poller.stop();
    poller.start(BUYER, 1_000_000n);
    await vi.advanceTimersByTimeAsync(0);
    rejectFirstRun(new Error('prior-epoch rpc timeout'));
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).not.toHaveBeenCalled();
    // The new run can still make progress: the prior epoch's RPC
    // rejection cleared inFlight (unconditionally), so the next
    // interval tick succeeds.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(publicClient.readContract).toHaveBeenCalledTimes(2);
    expect(onPoll).toHaveBeenCalledWith(0n);
    poller.stop();
  });

  it('stop() during a slow onFunded callback does not leak state for a subsequent start()', async () => {
    // Third-pass regression: tick() awaits `this.callbacks.onFunded(balance)`
    // (line 202 of funding-poll.ts). If the caller's onFunded body
    // awaits a long-running task (in production: `commitFundedTransition`'s
    // bounded-retry POST loop) and the caller `stop()`s the poller
    // mid-callback, a subsequent `start()` must work cleanly: no
    // stuck inFlight, no stale `fired` flag, no leaked interval.
    let resolveOnFunded!: () => void;
    const slowOnFunded = new Promise<void>((r) => {
      resolveOnFunded = r;
    });
    const onFunded = vi.fn().mockReturnValueOnce(slowOnFunded);
    const publicClient = makePublicClient([10_000_000n, 10_000_000n]);
    const poller = new FundingPoller({
      publicClient,
      usdcAddress: USDC,
      pollIntervalMs: 5_000,
      onFunded,
    });
    poller.start(BUYER, 1_000_000n);
    // The immediate tick reads 10_000_000n, fires onFunded (which is
    // hanging), then awaits the slow callback. isRunning is now false
    // (the interval was cleared inside tick() before invoking onFunded).
    await vi.advanceTimersByTimeAsync(0);
    expect(onFunded).toHaveBeenCalledTimes(1);
    expect(poller.isRunning).toBe(false);
    // Caller mid-callback stop() (simulating SSE-driven cleanup).
    poller.stop();
    // Now resolve the hanging callback. Nothing else should fire.
    resolveOnFunded();
    await Promise.resolve();
    await Promise.resolve();
    // Fresh start() — pre-funded kernel, must fire onFunded again.
    poller.start(BUYER, 1_000_000n);
    await vi.advanceTimersByTimeAsync(0);
    expect(onFunded).toHaveBeenCalledTimes(2);
    poller.stop();
  });
});
