/**
 * Wave 5 Slice 2c — runtime config for the standalone `muhaven-reinvest`
 * runner.
 *
 * The runner is a KEYLESS sidecar the broker auto-spawns. It reads the
 * SAME env the MCP server does (`loadMcpConfig`) — it inherits the broker's
 * process env at spawn time (backend / dashboard / bundler / subscription /
 * broker endpoint) — and layers a few reinvest-only knobs on top. It MUST
 * NOT see `MUHAVEN_BROKER_SESSION_KEY` (the spawn helper strips it); the
 * runner never signs.
 */

import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { loadMcpConfig, type McpRuntimeConfig } from '../config.js';
import { parseDecimalToUsd6 } from '../tools/decimal.js';

export interface ReinvestRuntimeConfig {
  /** Shared MCP config (broker endpoint, backend URL + allowed hosts,
   *  bundler URL, chain id, subscription + entry-point addresses, JWT TTL). */
  readonly mcp: McpRuntimeConfig;
  /**
   * Per-cycle cleartext reinvest budget in mhUSDC 6-dp base units. Converted
   * to a share count via the token's public NAV, then clamped to the per-op
   * cap. `0n` → the runner idles (budget disabled). Default $1 (1_000_000).
   * Sourced from `MUHAVEN_REINVEST_BUDGET_USD` (a decimal mhUSDC string).
   */
  readonly budgetUsd6: bigint;
  /** Poll interval (ms). Default 300_000 (5 min). Clamped to ≥30s. */
  readonly pollIntervalMs: number;
  /**
   * Per-(token,epoch) cooldown (ms) after a SUBMIT so a slow-settling UserOp
   * re-surfaced by the gate before its receipt lands isn't double-submitted.
   * Default 1_800_000 (30 min). The on-chain `hasClaimed` flag is the durable
   * dedup; this bridges the confirm window.
   */
  readonly cooldownMs: number;
  /** Absolute pidfile path (so `stop` / the broker can reach the runner). */
  readonly pidFilePath: string;
}

const DEFAULT_BUDGET_USD = '1';
const DEFAULT_POLL_INTERVAL_MS = 300_000;
const MIN_POLL_INTERVAL_MS = 30_000;
const DEFAULT_COOLDOWN_MS = 1_800_000;
/**
 * Hard floor for the per-(token,epoch) cooldown. The cooldown bridges the
 * submit→on-chain-`hasClaimed` confirm window so a slow-settling UserOp
 * (re-surfaced by the gate before its receipt lands) isn't re-submitted. It
 * MUST exceed the receipt-wait budget (12s) + indexer lag with margin — a
 * cooldown shorter than the confirm time would let the runner double-submit
 * every poll. 60s is the floor; the 30-min default is the realistic value.
 */
const MIN_COOLDOWN_MS = 60_000;

/** Compute the per-user pidfile path. Mirrors `defaultBrokerEndpoint`'s
 *  per-user, home-dir-rooted convention so two OS users don't collide. */
export function defaultReinvestPidPath(): string {
  return join(homedir(), '.muhaven', 'reinvest.pid');
}

/**
 * Logfile the broker-auto-spawned runner's stderr is redirected to. The
 * detached spawn uses `stdio:'ignore'` for stdout/IPC, but the runner's
 * JSON log lines (boot status, idle reasons, cycle outcomes, errors) MUST
 * land somewhere or a silent-idle / crash-looping runner is undebuggable.
 * Foreground `muhaven-reinvest` (operator-run in a terminal) keeps stderr on
 * the terminal — this redirect is spawn-only.
 */
export function defaultReinvestLogPath(): string {
  return join(homedir(), '.muhaven', 'reinvest.log');
}

function readEnvNonEmpty(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const v = env[name];
  return v === undefined || v === '' ? undefined : v;
}

function readEnvIntMs(
  name: string,
  defaultMs: number,
  minMs: number,
  unitMs: number,
  env: NodeJS.ProcessEnv,
): number {
  const raw = readEnvNonEmpty(name, env);
  if (raw === undefined) return defaultMs;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer (got "${raw}")`);
  }
  return Math.max(minMs, parsed * unitMs);
}

export function loadReinvestConfig(env: NodeJS.ProcessEnv = process.env): ReinvestRuntimeConfig {
  const mcp = loadMcpConfig(env);

  let budgetUsd6: bigint;
  const budgetRaw = readEnvNonEmpty('MUHAVEN_REINVEST_BUDGET_USD', env) ?? DEFAULT_BUDGET_USD;
  try {
    budgetUsd6 = parseDecimalToUsd6(budgetRaw);
  } catch {
    throw new Error(
      `MUHAVEN_REINVEST_BUDGET_USD must be a decimal mhUSDC amount (e.g. "1" or "1.5"), got ${JSON.stringify(budgetRaw)}`,
    );
  }

  const pollIntervalMs = readEnvIntMs(
    'MUHAVEN_REINVEST_POLL_INTERVAL_SEC',
    DEFAULT_POLL_INTERVAL_MS,
    MIN_POLL_INTERVAL_MS,
    1000,
    env,
  );
  const cooldownMs = readEnvIntMs(
    'MUHAVEN_REINVEST_COOLDOWN_SEC',
    DEFAULT_COOLDOWN_MS,
    MIN_COOLDOWN_MS,
    1000,
    env,
  );

  const pidFilePath = readEnvNonEmpty('MUHAVEN_REINVEST_PID_FILE', env) ?? defaultReinvestPidPath();

  return { mcp, budgetUsd6, pollIntervalMs, cooldownMs, pidFilePath };
}

/** Whether the runner can build UserOps at all (Path D configured). When
 *  false the runner stays alive but idles every cycle with a clear log —
 *  consistent with the "always spawn, idle until usable" operator choice. */
export function isReinvestExecutable(cfg: ReinvestRuntimeConfig): { ok: boolean; reason?: string } {
  if (cfg.budgetUsd6 <= 0n) {
    return { ok: false, reason: 'MUHAVEN_REINVEST_BUDGET_USD is 0 — reinvest budget disabled' };
  }
  if (!cfg.mcp.bundlerUrl) {
    return { ok: false, reason: 'MUHAVEN_BUNDLER_URL unset — Path D (UserOp build) disabled' };
  }
  if (!cfg.mcp.subscriptionAddress) {
    return { ok: false, reason: 'MUHAVEN_SUBSCRIPTION_ADDRESS unset — the buy leg has no target' };
  }
  return { ok: true };
}

/** Platform-correct kill hint for operator-facing messages. */
export function killHint(pid: number): string {
  return platform() === 'win32' ? `Stop-Process -Id ${pid}` : `kill ${pid}`;
}
