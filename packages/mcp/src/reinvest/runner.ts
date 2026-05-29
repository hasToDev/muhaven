/**
 * Wave 5 Slice 2c — the `muhaven-reinvest` poll loop.
 *
 * Per cycle (STATELESS re: credentials — every value is read live from the
 * broker / backend, never cached at boot, so a `broker login`/`logout` or a
 * session re-mint propagates on the next tick):
 *
 *   1. `broker.getJwt()` → null ⇒ idle (no creds → no reinvest).
 *   2. `GET /agent/reinvest/should-run` → the backend's public-data gate
 *      (active session + opt-in + claimable epochs). Not green ⇒ idle.
 *   3. For each claimable epoch (deduped per (token,epoch) via a cooldown
 *      that bridges the submit→on-chain-`hasClaimed` window):
 *      a. size the buy from the cleartext budget + the token's public NAV;
 *      b. `buildAndSubmitReinvestBatch` (atomic claim+buy, broker-signed);
 *      c. on a SUBMIT, record the `reinvest_cycle_executed` audit row.
 *
 * The runner holds NO key — it asks the broker to sign. Neither half alone
 * can move funds (Option D separation of duties).
 */

import { JwtSource } from '../auth/jwt-source.js';
import { BackendClient } from '../clients/backend-client.js';
import { BrokerClient } from '../clients/broker-client.js';
import { BundlerClient } from '../clients/bundler-client.js';
import { computeSharesFromUsd6, parseDecimalToUsd6 } from '../tools/decimal.js';
import {
  buildAndSubmitReinvestBatch,
  type ReinvestBatchDeps,
  type ReinvestBatchInput,
  type ReinvestBatchResult,
} from './execute.js';
import { isReinvestExecutable, type ReinvestRuntimeConfig } from './config.js';

export interface ReinvestLogEvent {
  readonly level: 'info' | 'warn' | 'error';
  readonly msg: string;
  readonly meta?: Record<string, unknown>;
}

export interface ReinvestRunnerDeps {
  readonly config: ReinvestRuntimeConfig;
  readonly broker: BrokerClient;
  /** May be undefined when Path D isn't configured — runner idles. */
  readonly bundler: BundlerClient | undefined;
  readonly backend: BackendClient;
  readonly logger?: (e: ReinvestLogEvent) => void;
  /** Injectable for tests. */
  readonly now?: () => number;
  readonly makeCycleId?: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The batch executor — defaults to `buildAndSubmitReinvestBatch`.
   *  Injectable so the poll-loop wiring (gating, dedup, audit) is unit-
   *  testable without driving a full UserOp build. */
  readonly executeBatch?: (
    input: ReinvestBatchInput,
    deps: ReinvestBatchDeps,
  ) => Promise<ReinvestBatchResult>;
}

interface ShouldRunEpoch {
  readonly token: string;
  readonly snapshotAddress: string;
  readonly epochId: string;
  readonly ratePerShare: string;
}
interface ShouldRunResponse {
  readonly shouldRun: boolean;
  readonly epochs: readonly ShouldRunEpoch[];
  readonly reason?: string;
}
interface TokenCatalogEntry {
  readonly address: string;
  readonly symbol: string;
  readonly latest_nav?: { readonly nav?: string } | null;
  /** Per-token YieldSnapshot proxy. Used to CROSS-CHECK the gate's
   *  `snapshotAddress` (defense-in-depth: the no-LLM-in-loop runner trusts
   *  the backend for both legs' targets, so we bind the (token, snapshot)
   *  pairing to a second backend source). */
  readonly yield_snapshot_address?: string | null;
}
interface TokenCatalogResponse {
  readonly tokens?: readonly TokenCatalogEntry[];
}

const ADDRESS_HEX = /^0x[0-9a-fA-F]{40}$/;

const noopLogger = (_e: ReinvestLogEvent): void => {};
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class ReinvestRunner {
  private readonly cfg: ReinvestRuntimeConfig;
  private readonly broker: BrokerClient;
  private readonly bundler: BundlerClient | undefined;
  private readonly backend: BackendClient;
  private readonly log: (e: ReinvestLogEvent) => void;
  private readonly now: () => number;
  private readonly makeCycleId: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  /** (token:epoch) → last-submit ms. Bounds re-submission of a slow-settling
   *  UserOp within the confirm window (on-chain hasClaimed is the durable
   *  dedup once the gate's RPC read reflects it). */
  private readonly cooldown = new Map<string, number>();
  private stopped = false;
  private executableLogged = false;
  private readonly executeBatch: (
    input: ReinvestBatchInput,
    deps: ReinvestBatchDeps,
  ) => Promise<ReinvestBatchResult>;

  constructor(deps: ReinvestRunnerDeps) {
    this.cfg = deps.config;
    this.broker = deps.broker;
    this.bundler = deps.bundler;
    this.backend = deps.backend;
    this.log = deps.logger ?? noopLogger;
    this.now = deps.now ?? (() => Date.now());
    this.makeCycleId = deps.makeCycleId ?? (() => globalThis.crypto.randomUUID());
    this.sleep = deps.sleep ?? defaultSleep;
    this.executeBatch = deps.executeBatch ?? buildAndSubmitReinvestBatch;
  }

  /** Loop until `stop()`. Sleeps `pollIntervalMs` between cycles. */
  async start(): Promise<void> {
    this.stopped = false;
    this.log({ level: 'info', msg: 'reinvest runner started', meta: { pollIntervalMs: this.cfg.pollIntervalMs } });
    while (!this.stopped) {
      try {
        await this.runCycle();
      } catch (err) {
        this.log({ level: 'error', msg: 'reinvest cycle threw', meta: { err: errStr(err) } });
      }
      if (this.stopped) break;
      await this.sleep(this.cfg.pollIntervalMs);
    }
  }

  stop(): void {
    this.stopped = true;
  }

  /** ONE poll cycle. Exposed for unit tests. Never throws — every failure
   *  is logged + the cycle ends (retried next interval). */
  async runCycle(): Promise<void> {
    // 0. Path D configured? Idle (log once) if not — keeps the "always
    //    spawn, idle until usable" posture without log spam.
    const executable = isReinvestExecutable(this.cfg);
    if (!executable.ok) {
      if (!this.executableLogged) {
        this.log({ level: 'info', msg: `reinvest idle — ${executable.reason}` });
        this.executableLogged = true;
      }
      return;
    }
    this.executableLogged = false;

    // 1. Credentials live from the broker. No JWT ⇒ idle (logged out).
    let jwt: string | null;
    try {
      jwt = (await this.broker.getJwt()).jwt;
    } catch (err) {
      this.log({ level: 'warn', msg: 'reinvest idle — broker get_jwt failed', meta: { err: errStr(err) } });
      return;
    }
    if (!jwt) {
      this.log({ level: 'info', msg: 'reinvest idle — no JWT in broker keystore (run `muhaven-broker login`)' });
      return;
    }

    // 2. Gate.
    let gate: ShouldRunResponse;
    try {
      gate = await this.backend.get<ShouldRunResponse>('/api/v1/agent/reinvest/should-run');
    } catch (err) {
      this.log({ level: 'warn', msg: 'reinvest should-run gate failed', meta: { err: errStr(err) } });
      return;
    }
    if (!gate.shouldRun || gate.epochs.length === 0) {
      this.log({ level: 'info', msg: 'reinvest gate closed', meta: { reason: gate.reason ?? 'none' } });
      return;
    }

    // 3. Token catalog (public NAV for buy sizing).
    let catalog: TokenCatalogResponse;
    try {
      catalog = await this.backend.getUnauth<TokenCatalogResponse>('/api/v1/tokens');
    } catch (err) {
      this.log({ level: 'warn', msg: 'reinvest could not fetch token catalog — skipping cycle', meta: { err: errStr(err) } });
      return;
    }
    const catalogByAddress = new Map<string, TokenCatalogEntry>();
    for (const t of catalog.tokens ?? []) {
      if (typeof t.address === 'string' && ADDRESS_HEX.test(t.address)) {
        catalogByAddress.set(t.address.toLowerCase(), t);
      }
    }

    const batchDeps: ReinvestBatchDeps = {
      broker: this.broker,
      bundler: this.bundler!,
      backend: this.backend,
      entryPointAddress: this.cfg.mcp.entryPointAddress,
      chainId: this.cfg.mcp.chainId,
      subscriptionAddress: this.cfg.mcp.subscriptionAddress!,
    };

    for (const epoch of gate.epochs) {
      if (this.stopped) return;
      await this.processEpoch(epoch, catalogByAddress, batchDeps);
    }
  }

  private async processEpoch(
    epoch: ShouldRunEpoch,
    catalog: Map<string, TokenCatalogEntry>,
    batchDeps: ReinvestBatchDeps,
  ): Promise<void> {
    if (!ADDRESS_HEX.test(epoch.token) || !ADDRESS_HEX.test(epoch.snapshotAddress)) {
      this.log({ level: 'warn', msg: 'reinvest skipping malformed epoch target', meta: { epoch } });
      return;
    }
    let epochId: bigint;
    try {
      epochId = BigInt(epoch.epochId);
    } catch {
      this.log({ level: 'warn', msg: 'reinvest skipping non-numeric epochId', meta: { epoch } });
      return;
    }
    if (epochId <= 0n) return; // epoch 0 is the no-epoch sentinel

    const key = `${epoch.token.toLowerCase()}:${epochId.toString()}`;
    const nowMs = this.now();
    const last = this.cooldown.get(key);
    if (last !== undefined) {
      if (nowMs - last < this.cfg.cooldownMs) {
        this.log({ level: 'info', msg: 'reinvest epoch on cooldown — skipping', meta: { key } });
        return;
      }
      // Expired — drop it so the map doesn't accumulate one dead entry per
      // (token, epoch) over the daemon's lifetime (bounded prune, cheap).
      this.cooldown.delete(key);
    }

    const entry = catalog.get(epoch.token.toLowerCase());
    const navRaw = entry?.latest_nav?.nav;
    if (!entry || !navRaw) {
      this.log({ level: 'warn', msg: 'reinvest skipping epoch — no NAV for token', meta: { token: epoch.token } });
      return;
    }
    // Cross-check the gate's (token → snapshot) pairing against the public
    // catalog (defense-in-depth — the runner has no human reviewing the
    // targets). When the catalog carries a snapshot for this token it MUST
    // match the gate's; a mismatch means the two backend reads disagree —
    // refuse rather than claim against an unexpected snapshot. (When the
    // catalog omits it, the on-chain CallPolicy target allowlist that
    // `execute.ts` re-checks is the backstop.)
    if (
      entry.yield_snapshot_address &&
      ADDRESS_HEX.test(entry.yield_snapshot_address) &&
      entry.yield_snapshot_address.toLowerCase() !== epoch.snapshotAddress.toLowerCase()
    ) {
      this.log({
        level: 'warn',
        msg: 'reinvest skipping epoch — gate snapshot disagrees with the token catalog',
        meta: {
          token: epoch.token,
          gateSnapshot: epoch.snapshotAddress,
          catalogSnapshot: entry.yield_snapshot_address,
        },
      });
      return;
    }
    let navUsd6: bigint;
    try {
      navUsd6 = parseDecimalToUsd6(navRaw);
    } catch {
      this.log({ level: 'warn', msg: 'reinvest skipping epoch — malformed NAV', meta: { token: epoch.token } });
      return;
    }
    if (navUsd6 <= 0n) return;
    const requestedShares = computeSharesFromUsd6(this.cfg.budgetUsd6, navUsd6);
    if (requestedShares <= 0n) {
      this.log({
        level: 'info',
        msg: 'reinvest budget too small for 1 share at current NAV — skipping epoch',
        meta: { token: epoch.token, navUsd6: navUsd6.toString(), budgetUsd6: this.cfg.budgetUsd6.toString() },
      });
      return;
    }

    const reinvestCycleId = this.makeCycleId();
    const result = await this.executeBatch(
      {
        epochId,
        tokenAddress: epoch.token.toLowerCase() as `0x${string}`,
        // Sanitize the issuer-controlled symbol before it flows into the
        // broker's `intent.summary` (a log sink): strip control/ANSI chars +
        // clamp length so a crafted symbol can't spam the broker log.
        tokenSymbol: sanitizeSymbol(entry.symbol),
        snapshotAddress: epoch.snapshotAddress.toLowerCase() as `0x${string}`,
        requestedShares,
        budgetUsd6: this.cfg.budgetUsd6,
        reinvestCycleId,
      },
      batchDeps,
    );

    if (result.kind === 'skip') {
      this.log({ level: 'info', msg: `reinvest epoch skipped — ${result.reason}`, meta: { key, detail: result.message } });
      return;
    }

    // ok | submitted_no_receipt → set cooldown + record the audit.
    this.cooldown.set(key, this.now());
    const txHash = result.kind === 'ok' ? result.txHash : undefined;
    this.log({
      level: 'info',
      msg: result.kind === 'ok' ? 'reinvest cycle landed' : 'reinvest cycle submitted (receipt pending)',
      meta: { key, userOpHash: result.userOpHash, ...(txHash ? { txHash } : {}), cycle: reinvestCycleId },
    });
    await this.recordAudit({
      reinvestCycleId,
      epochId: epochId.toString(),
      tokenAddress: epoch.token.toLowerCase(),
      snapshotAddress: epoch.snapshotAddress.toLowerCase(),
      userOpHash: result.userOpHash,
      txHash,
      buyShares: result.buyShares.toString(),
      budgetUsd6: this.cfg.budgetUsd6.toString(),
    });
  }

  private async recordAudit(body: {
    reinvestCycleId: string;
    epochId: string;
    tokenAddress: string;
    snapshotAddress: string;
    userOpHash: string;
    txHash?: string;
    buyShares: string;
    budgetUsd6: string;
  }): Promise<void> {
    // Omit `txHash` entirely when absent (submitted_no_receipt) — the
    // backend DTO is `.strict()` + treats txHash as optional; sending the
    // key with an undefined value is avoided so the wire stays clean.
    const { txHash, ...rest } = body;
    const payload = txHash ? { ...rest, txHash } : rest;
    try {
      await this.backend.post('/api/v1/agent/reinvest/cycle', payload);
    } catch (err) {
      // Best-effort — the on-chain tx is the authoritative record. A failed
      // audit POST is logged but never blocks / re-runs the cycle.
      this.log({ level: 'warn', msg: 'reinvest audit record failed (non-fatal)', meta: { err: errStr(err) } });
    }
  }
}

/** Wire a runner against the real clients from a loaded config. */
export function buildReinvestRunner(
  cfg: ReinvestRuntimeConfig,
  logger?: (e: ReinvestLogEvent) => void,
): ReinvestRunner {
  const broker = new BrokerClient({ endpoint: cfg.mcp.brokerEndpoint, timeoutMs: cfg.mcp.brokerTimeoutMs });
  // TTL 0 (no cache): the runner polls every ~5 min, so there is no hot path
  // to protect (the 30s cache exists for the MCP server's per-tool-call hot
  // path). A 0 TTL makes the kill-switch genuinely live — a `broker logout`
  // propagates to the gate/state reads on the very next cycle, matching the
  // runner's "stateless re: credentials" contract.
  const jwtSource = new JwtSource(broker, 0);
  const backend = new BackendClient({
    baseUrl: cfg.mcp.backendBaseUrl,
    jwtSource,
    timeoutMs: cfg.mcp.requestTimeoutMs,
    allowedHosts: cfg.mcp.allowedBackendHosts,
  });
  const bundler = cfg.mcp.bundlerUrl
    ? new BundlerClient({
        endpoint: cfg.mcp.bundlerUrl,
        requestTimeoutMs: cfg.mcp.bundlerTimeoutMs,
        expectedChainId: cfg.mcp.chainId,
        originHeader: cfg.mcp.dashboardBaseUrl,
      })
    : undefined;
  return new ReinvestRunner({ config: cfg, broker, bundler, backend, logger });
}

function errStr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Strip C0/C1 control + DEL chars and clamp to 32 chars. The token symbol
 *  crosses an issuer-controlled boundary (the nav-worker writes what the
 *  issuer reports) and flows into the broker's `intent.summary` log field, so
 *  a crafted symbol must not inject control/ANSI sequences or spam the log. */
function sanitizeSymbol(symbol: string): string {
  let out = '';
  for (const ch of symbol) {
    const c = ch.codePointAt(0) ?? 0;
    // Drop C0 controls (0x00-0x1F), DEL (0x7F), and C1 controls (0x80-0x9F).
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) continue;
    out += ch;
    if (out.length >= 32) break;
  }
  return out;
}
