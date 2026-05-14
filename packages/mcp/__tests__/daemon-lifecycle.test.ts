import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir, platform } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

const BIN = join(__dirname, '..', 'bin', 'muhaven-broker.cjs');
const MCP_BIN = join(__dirname, '..', 'bin', 'muhaven-mcp.cjs');
// Throwaway 32-byte hex; never used for signing in this test.
const TEST_SESSION_KEY =
  '0x' + 'a'.repeat(64);

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForExit(child: ChildProcess, ms: number): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe('muhaven-broker bin lifecycle', () => {
  let child: ChildProcess | null = null;

  afterEach(() => {
    if (child && child.exitCode === null && !child.killed) {
      child.kill('SIGKILL');
    }
    child = null;
  });

  it('daemon stays alive after start (no immediate process.exit)', async () => {
    // Use a per-test endpoint to avoid colliding with a real broker the
    // operator might be running. On POSIX use a unique tmpdir; on
    // Windows use a unique pipe name.
    const endpoint =
      platform() === 'win32'
        ? `\\\\.\\pipe\\muhaven-broker-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        : join(mkdtempSync(join(tmpdir(), 'muhaven-broker-test-')), 'broker.sock');

    child = spawn(process.execPath, [BIN], {
      env: {
        ...process.env,
        MUHAVEN_BROKER_SESSION_KEY: TEST_SESSION_KEY,
        MUHAVEN_BROKER_ENDPOINT: endpoint,
        MUHAVEN_KEYRING: 'file',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    // Give the process time to either crash or settle into listening state.
    const earlyExit = await waitForExit(child, 1500);
    if (earlyExit !== null) {
      throw new Error(
        `daemon exited with code ${earlyExit} within 1.5s of starting. ` +
          `stderr=${stderr || '(empty)'} stdout=${stdout || '(empty)'}`,
      );
    }
    expect(child.exitCode).toBeNull();
    expect(child.killed).toBe(false);

    // Verify the listening message reached stderr (the daemon's structured logger).
    expect(stderr).toContain('broker daemon listening');

    // Clean shutdown via SIGTERM should exit 0.
    child.kill('SIGTERM');
    const exitCode = await waitForExit(child, 3000);
    // Windows reports null for SIGTERM-killed children; POSIX returns 0.
    if (platform() !== 'win32') {
      expect(exitCode).toBe(0);
    }
  }, 10_000);

  it('daemon boots in read-only posture when MUHAVEN_BROKER_SESSION_KEY is absent', async () => {
    // Behavior change in @muhaven/mcp@0.1.3: the daemon no longer exits
    // when MUHAVEN_BROKER_SESSION_KEY is missing — it boots into a
    // read-only posture where `sign_hash` returns `session_key_unavailable`
    // but `hello` + JWT verbs still work. Closes §3e⁶
    // F-broker-session-key-required-for-reads.
    const endpoint =
      platform() === 'win32'
        ? `\\\\.\\pipe\\muhaven-broker-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        : join(mkdtempSync(join(tmpdir(), 'muhaven-broker-test-')), 'broker.sock');

    child = spawn(process.execPath, [BIN], {
      env: {
        // Strip MUHAVEN_BROKER_SESSION_KEY out of the inherited env.
        ...Object.fromEntries(
          Object.entries(process.env).filter(([k]) => k !== 'MUHAVEN_BROKER_SESSION_KEY'),
        ),
        MUHAVEN_BROKER_ENDPOINT: endpoint,
        MUHAVEN_KEYRING: 'file',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    // The daemon should NOT exit within 1.5s — it's listening in read-only mode.
    const earlyExit = await waitForExit(child, 1500);
    if (earlyExit !== null) {
      throw new Error(
        `daemon exited with code ${earlyExit} within 1.5s. ` +
          `Expected read-only posture, not exit. stderr=${stderr || '(empty)'}`,
      );
    }
    expect(child.exitCode).toBeNull();
    expect(stderr).toContain('read-only posture');
    expect(stderr).toContain('broker daemon listening');

    child.kill('SIGTERM');
    await waitForExit(child, 3000);
  }, 10_000);

  it('daemon exits with non-zero on a malformed session key', async () => {
    child = spawn(process.execPath, [BIN], {
      env: {
        ...process.env,
        MUHAVEN_BROKER_SESSION_KEY: '0xdeadbeef',
        MUHAVEN_KEYRING: 'file',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const exitCode = await waitForExit(child, 5000);
    expect(exitCode).not.toBeNull();
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/MUHAVEN_BROKER_SESSION_KEY/);
    expect(stderr).toMatch(/32-byte hex/);
  }, 10_000);
});

describe('muhaven-mcp bin lifecycle', () => {
  let child: ChildProcess | null = null;

  afterEach(() => {
    if (child && child.exitCode === null && !child.killed) {
      child.kill('SIGKILL');
    }
    child = null;
  });

  it('mcp server stays alive after stdio transport connects (no immediate process.exit)', async () => {
    // The host (Claude Desktop / Cursor / Claude Code) spawns the MCP server
    // as a STDIO subprocess and expects it to outlive the initial handshake.
    // Earlier the bin's `.then(() => process.exit(0))` killed the process
    // the moment `runMcpStdioCli()` resolved (immediately after
    // `transport.connect`), so the host saw the JSON-RPC pipe slam shut
    // before it could send `initialize`. This test guards that regression.
    child = spawn(process.execPath, [MCP_BIN], {
      env: {
        ...process.env,
        MUHAVEN_BACKEND_URL: 'https://api-stage.muhaven.app',
        MUHAVEN_DASHBOARD_URL: 'http://localhost:7778',
        MUHAVEN_KEYRING: 'file',
      },
      // 'pipe' on stdin so the parent can keep it open — matches what
      // a real MCP host does. Closing stdin would (correctly) terminate
      // the server, which is the OTHER half of the lifecycle contract.
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    // Give the bin time to either crash (tool-hash drift, missing config)
    // or settle into the parked-on-stdin state.
    const earlyExit = await waitForExit(child, 1500);
    if (earlyExit !== null) {
      throw new Error(
        `mcp server exited with code ${earlyExit} within 1.5s of starting. ` +
          `stderr=${stderr || '(empty)'}`,
      );
    }
    expect(child.exitCode).toBeNull();
    expect(child.killed).toBe(false);

    // Closing stdin should drain the parked promise and exit cleanly.
    child.stdin?.end();
    const exitCode = await waitForExit(child, 3000);
    if (platform() !== 'win32') {
      expect(exitCode).toBe(0);
    }
  }, 10_000);
});
