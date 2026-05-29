/**
 * `muhaven-reinvest` CLI — the keyless auto-reinvest runner.
 *
 * Subcommands:
 *   (none)         → run the poll loop (the broker auto-spawns this form)
 *   stop           → SIGTERM the running runner via its pidfile
 *   doctor         → config + broker-reachability + executable report
 *   --version, -v  → @muhaven/mcp version
 *   --help, -h     → usage
 *
 * The runner is STATELESS re: credentials (reads the JWT + session live
 * from the broker every cycle) and KEYLESS (asks the broker to sign). It is
 * usually started/stopped by `muhaven-broker start`/`stop`, but the
 * subcommands let an operator drive it directly.
 */

import { BrokerClient } from '../clients/broker-client.js';
import { isReinvestExecutable, loadReinvestConfig, defaultReinvestLogPath } from './config.js';
import { writeReinvestPid, clearReinvestPid } from './pidfile.js';
import { stopReinvestRunner, reinvestRunnerPid } from './lifecycle.js';
import { buildReinvestRunner, type ReinvestRunner } from './runner.js';

function print(line: string): void {
  process.stdout.write(line + '\n');
}
function printErr(line: string): void {
  process.stderr.write(line + '\n');
}

declare const __SERVER_VERSION__: string | undefined;
export function getReinvestPackageVersion(): string {
  if (typeof __SERVER_VERSION__ === 'string' && __SERVER_VERSION__) return __SERVER_VERSION__;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pkg = require('../../package.json') as { version: string };
  return pkg.version;
}

/** Structured JSON log line to STDERR (STDOUT stays clean). */
function jsonLog(e: { level: string; msg: string; meta?: Record<string, unknown> }): void {
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');
}

/** Run the poll loop attached to this process (the daemon form). */
export async function runReinvestDaemonCli(): Promise<void> {
  const cfg = loadReinvestConfig();
  const exec = isReinvestExecutable(cfg);
  jsonLog({
    level: 'info',
    msg: 'muhaven-reinvest booting',
    meta: {
      executable: exec.ok,
      ...(exec.reason ? { idleReason: exec.reason } : {}),
      pollIntervalSec: Math.round(cfg.pollIntervalMs / 1000),
      budgetUsd6: cfg.budgetUsd6.toString(),
      brokerEndpoint: cfg.mcp.brokerEndpoint,
    },
  });

  // Refuse a second instance — two runners would race independent cooldown
  // maps and could double-submit a reinvest. (The broker only auto-spawns
  // one, but a stray manual `muhaven-reinvest` shouldn't double up.)
  const existing = await reinvestRunnerPid({ pidFilePath: cfg.pidFilePath });
  if (existing !== null && existing !== process.pid) {
    jsonLog({ level: 'info', msg: 'muhaven-reinvest already running — exiting', meta: { pid: existing } });
    return;
  }

  await writeReinvestPid(cfg.pidFilePath, process.pid);

  const runner: ReinvestRunner = buildReinvestRunner(cfg, jsonLog);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    runner.stop();
    await clearReinvestPid(cfg.pidFilePath);
    jsonLog({ level: 'info', msg: 'muhaven-reinvest stopped' });
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await runner.start();
  // start() only returns once stopped; ensure the pidfile is cleared.
  await clearReinvestPid(cfg.pidFilePath);
}

export async function runReinvestStop(): Promise<number> {
  let pidPath: string;
  try {
    pidPath = loadReinvestConfig().pidFilePath;
  } catch {
    pidPath = undefined as unknown as string; // fall back to default inside stop
  }
  const outcome = await stopReinvestRunner(pidPath ? { pidFilePath: pidPath } : {});
  switch (outcome.status) {
    case 'not_running':
      print('Reinvest runner: not running, nothing to stop.');
      return 0;
    case 'stopped':
      print(`Reinvest runner stopped cleanly (PID ${outcome.pid}).`);
      return 0;
    case 'killed':
      print(`Reinvest runner did not exit gracefully — force-killed (PID ${outcome.pid}).`);
      return 0;
    case 'error':
      printErr(`Failed to stop reinvest runner (PID ${outcome.pid}): ${outcome.reason}`);
      return 1;
  }
}

export async function runReinvestDoctor(): Promise<number> {
  print('muhaven-reinvest doctor');
  print('=======================');
  let cfg;
  try {
    cfg = loadReinvestConfig();
  } catch (err) {
    printErr(`config error: ${(err as Error).message}`);
    return 1;
  }
  const exec = isReinvestExecutable(cfg);
  print(`Executable        : ${exec.ok ? 'yes' : `no — ${exec.reason}`}`);
  print(`Budget (usd6)     : ${cfg.budgetUsd6.toString()}`);
  print(`Poll interval     : ${Math.round(cfg.pollIntervalMs / 1000)}s`);
  print(`Cooldown          : ${Math.round(cfg.cooldownMs / 1000)}s`);
  print(`Broker endpoint   : ${cfg.mcp.brokerEndpoint}`);
  print(`Backend URL       : ${cfg.mcp.backendBaseUrl}`);
  print(`Bundler URL       : ${cfg.mcp.bundlerUrl ?? '(unset — Path D disabled)'}`);
  print(`Subscription      : ${cfg.mcp.subscriptionAddress ?? '(unset)'}`);
  print(`Pidfile           : ${cfg.pidFilePath}`);
  print(`Logfile (spawned) : ${defaultReinvestLogPath()}`);

  const broker = new BrokerClient({
    endpoint: cfg.mcp.brokerEndpoint,
    timeoutMs: cfg.mcp.brokerTimeoutMs,
  });
  try {
    const h = await broker.hello();
    const hasKey = h.hasSessionKey ?? true;
    print(`Broker daemon     : reachable (proto v${h.version}, ${hasKey ? 'signer ' + h.sessionKeyAddress : 'NO KEY'}, hasJwt=${h.hasJwt})`);
    if (!h.hasJwt) print('  note: no JWT in keystore — the runner idles until `muhaven-broker login`.');
  } catch (err) {
    print(`Broker daemon     : NOT reachable (${(err as Error).message})`);
    print('  hint: start it with `muhaven-broker start` (which also spawns this runner).');
    return 1;
  }
  return 0;
}

function printUsage(): void {
  print('usage: muhaven-reinvest [<subcommand>]');
  print('');
  print('  (no subcommand)    Run the auto-reinvest poll loop (broker auto-spawns this)');
  print('  stop               Stop a running runner (SIGTERM → SIGKILL fallback)');
  print('  doctor             Print config + broker-reachability report');
  print('  -h, --help         Show this help');
  print('  -v, --version      Print the @muhaven/mcp package version');
  print('');
  print('Env knobs: MUHAVEN_REINVEST_BUDGET_USD (default 1), MUHAVEN_REINVEST_POLL_INTERVAL_SEC');
  print('           (default 300), MUHAVEN_REINVEST_COOLDOWN_SEC (default 1800).');
  print('The runner reuses the broker creds live — no separate login/key. It is KEYLESS.');
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const [sub] = argv;
  switch (sub) {
    case undefined:
      await runReinvestDaemonCli();
      return 0;
    case 'stop':
      return runReinvestStop();
    case 'doctor':
      return runReinvestDoctor();
    case '-h':
    case '--help':
      printUsage();
      return 0;
    case '-v':
    case '--version':
      print(`muhaven-reinvest @muhaven/mcp@${getReinvestPackageVersion()}`);
      return 0;
    default:
      printErr(`unknown subcommand: ${sub}`);
      printUsage();
      return 2;
  }
}
