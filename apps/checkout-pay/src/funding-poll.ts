/**
 * Wave 4 P5 (Wave-5 buyer-side port, P2) — USDC balance polling for the
 * hosted-checkout buyer page.
 *
 * After the passkey ceremony provisions a kernel address (P1), this
 * poller runs viem `readContract(USDC.balanceOf)` against the kernel
 * every 5 s. When the balance crosses the required amount, `onFunded`
 * fires exactly once and the interval stops. The page reconciles by
 * calling `backend.transition({newStatus: 'funded', buyerAddress})`;
 * the backend SSE channel then propagates the new state.
 *
 * Design choices:
 *  - **Pull, not push.** The buyer page is static; there is no server
 *    process to subscribe for "USDC arrived" events. viem
 *    `watchContractEvent` on USDC `Transfer` is possible but produces a
 *    steady stream of unrelated transfers — balance polling is the
 *    simpler primitive and avoids subscriber-side filtering.
 *  - **Immediate first poll.** The poller fires once on `start()` so a
 *    pre-funded kernel (the buyer topped up before opening the link)
 *    advances instantly.
 *  - **Single-shot firing.** `onFunded` fires AT MOST ONCE per
 *    `start()` invocation, regardless of how many ticks observe a
 *    balance above the threshold. Polling stops the moment the
 *    threshold is crossed.
 *  - **In-flight guard.** A slow RPC (>5 s) does not stack polls — the
 *    next tick is skipped if a prior one is still resolving.
 *  - **Errors don't crash.** RPC failures surface via `onError`; the
 *    interval continues. A faucet drop that arrives between two failed
 *    polls still triggers `onFunded` on the next successful read.
 *  - **Re-entrancy safe.** `stop()` mid-flight cancels. Every `start()`
 *    and `stop()` rolls a `runEpoch` token. Each tick captures the
 *    epoch at entry and re-checks after every await — a stale
 *    resolution (success OR error) from a prior epoch is suppressed
 *    against the current run's callbacks. The `inFlight` slot is
 *    always cleared on resolution regardless of epoch so a new run
 *    can make progress after the prior run's RPC eventually settles.
 */

import { erc20Abi, type Address, type PublicClient } from 'viem';
import { getPublicClient, getUsdcAddress } from './chain.js';

const DEFAULT_POLL_INTERVAL_MS = 5_000;

export interface FundingPollerCallbacks {
  /** Fires AT MOST ONCE per `start()` invocation, when the buyer's
   *  USDC balance crosses the required threshold. Polling is stopped
   *  before this callback runs so re-entrant `start()` / `stop()` calls
   *  from inside the callback are safe. Errors thrown by `onFunded`
   *  bubble as an unhandled rejection — the caller is responsible for
   *  surfacing backend / network errors (typically with a try/catch +
   *  UI fallback). */
  onFunded: (balance: bigint) => void | Promise<void>;
  /** Optional: fires on every successful poll. Useful for live UI
   *  (e.g. "Current balance: X.XX USDC"). */
  onPoll?: (balance: bigint) => void;
  /** Optional: fires on RPC errors. Polling continues — the next
   *  interval tick will retry. The caller decides whether to surface
   *  transient errors in the UI (typically: no — keep the user calm). */
  onError?: (err: unknown) => void;
}

export interface FundingPollerOptions extends FundingPollerCallbacks {
  /** Injectable for tests. Defaults to the singleton from `chain.ts`. */
  publicClient?: PublicClient;
  /** Injectable for tests. Defaults to the env-resolved USDC address. */
  usdcAddress?: Address;
  /** Defaults to 5000 ms (12 polls/min). Test seam — keep small. */
  pollIntervalMs?: number;
}

export class FundingPoller {
  private readonly publicClient: PublicClient;
  private readonly usdcAddress: Address;
  private readonly pollIntervalMs: number;
  private readonly callbacks: FundingPollerCallbacks;

  private intervalId: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private buyerAddress: Address | null = null;
  private required: bigint = 0n;
  private fired = false;
  private stopped = true;
  /**
   * Per-`start()` epoch. Incremented on every `start()` (and on
   * `stop()`). Every tick captures the epoch at entry and re-checks
   * it after the `readContract` await — if the epoch has rolled, a
   * stale resolution (success OR error) is suppressed. Without this
   * token, a slow RPC that resolves after `stop()` + `start()` would
   * fire `onPoll` / `onFunded` / `onError` against the new run's
   * caller — see Code Reviewer findings #3, #4 (2026-05-13 review).
   */
  private runEpoch = 0;

  constructor(opts: FundingPollerOptions) {
    this.publicClient = opts.publicClient ?? getPublicClient();
    this.usdcAddress = opts.usdcAddress ?? getUsdcAddress();
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.callbacks = {
      onFunded: opts.onFunded,
      onPoll: opts.onPoll,
      onError: opts.onError,
    };
  }

  /** True while an active `start()` has not been stopped AND the
   *  funded threshold has not yet been crossed. Useful for tests and
   *  for idempotency guards in the page (skip re-start if already
   *  running for the same address). */
  get isRunning(): boolean {
    return this.intervalId !== null;
  }

  start(buyerAddress: Address, requiredAmountUsd6: bigint): void {
    // Replace any prior run. Two starts in a row before stop() rebind
    // the address + threshold; the prior interval is cleared.
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.runEpoch += 1;
    this.buyerAddress = buyerAddress;
    this.required = requiredAmountUsd6;
    this.fired = false;
    this.stopped = false;
    // First poll runs immediately (no 5 s wait) so a pre-funded kernel
    // crosses the threshold on the synchronous tick.
    void this.tick();
    this.intervalId = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    this.runEpoch += 1;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Test seam — manually invoke a single poll cycle. Production paths
   *  should not call this; `start()` drives the interval. */
  pollOnce(): Promise<bigint | null> {
    return this.tick();
  }

  private async tick(): Promise<bigint | null> {
    if (this.stopped) return null;
    if (this.fired) return null;
    if (this.inFlight) return null;
    if (!this.buyerAddress) return null;

    // Snapshot the epoch at entry. If `stop()` (or a fresh `start()`)
    // runs while the RPC is in flight, the post-await comparison will
    // suppress this tick's side effects.
    const epoch = this.runEpoch;

    this.inFlight = true;
    let balance: bigint;
    try {
      balance = (await this.publicClient.readContract({
        address: this.usdcAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [this.buyerAddress],
      })) as bigint;
    } catch (err) {
      // Always clear inFlight regardless of epoch — a NEW run can't
      // have re-set it in the meantime because its tick() short-
      // circuits on `this.inFlight` (i.e., this tick still owned the
      // slot until now). Without this unconditional clear, a slow
      // prior-epoch RPC that resolves after stop()+start() would
      // leave inFlight stuck true → the new run's ticks would
      // permanently short-circuit.
      this.inFlight = false;
      if (epoch !== this.runEpoch) return null;
      this.callbacks.onError?.(err);
      return null;
    }
    this.inFlight = false;

    // Re-check epoch/fired AFTER the await — a stop() or stop()+start()
    // that races a slow RPC must not trigger onPoll / onFunded with
    // stale data, and a prior tick within the same run may have
    // already fired onFunded.
    if (epoch !== this.runEpoch) return balance;
    if (this.fired) return balance;

    this.callbacks.onPoll?.(balance);

    // `>=` (not `>`) — a kernel funded EXACTLY to required must
    // advance. The threshold is half-open from below.
    if (balance >= this.required) {
      this.fired = true;
      // Stop the interval BEFORE invoking onFunded so re-entrant
      // start() / stop() from inside the callback are safe.
      if (this.intervalId !== null) {
        clearInterval(this.intervalId);
        this.intervalId = null;
      }
      await this.callbacks.onFunded(balance);
    }
    return balance;
  }
}
