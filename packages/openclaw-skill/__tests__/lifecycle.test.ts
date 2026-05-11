import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { platform } from 'node:os';
import { join } from 'node:path';

const BIN = join(__dirname, '..', 'bin', 'muhaven-rwa-skill.cjs');

const EXPECTED_TOOLS: readonly string[] = [
  'muhaven.read.portfolio',
  'muhaven.read.yields',
  'muhaven.read.distribution',
  'muhaven.read.tokens',
  'muhaven.read.audit',
  'muhaven.read.protection_coverage',
  'muhaven.read.kyc_attestation',
  'muhaven.position.buy',
  'muhaven.position.claim',
  'muhaven.policy.pause',
  'muhaven.policy.session_key_status',
];

function waitForExit(child: ChildProcess, ms: number): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function readNdjsonResponses(child: ChildProcess, onMessage: (msg: unknown) => void): void {
  let buffer = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        // ignore framing artifacts
      }
    }
  });
}

describe('muhaven-rwa-skill bin lifecycle', () => {
  let child: ChildProcess | null = null;

  afterEach(() => {
    if (child && child.exitCode === null && !child.killed) {
      child.kill('SIGKILL');
    }
    child = null;
  });

  it('skill bin stays alive after stdio transport connects', async () => {
    child = spawn(process.execPath, [BIN], {
      env: {
        ...process.env,
        MUHAVEN_BACKEND_URL: 'https://api-stage.muhaven.app',
        MUHAVEN_DASHBOARD_URL: 'http://localhost:7778',
        MUHAVEN_KEYRING: 'file',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const earlyExit = await waitForExit(child, 1500);
    if (earlyExit !== null) {
      throw new Error(
        `skill bin exited with code ${earlyExit} within 1.5s. ` +
          `stderr=${stderr || '(empty)'}`,
      );
    }
    expect(child.exitCode).toBeNull();
    expect(child.killed).toBe(false);

    child.stdin?.end();
    const exitCode = await waitForExit(child, 3000);
    if (platform() === 'win32') {
      // Windows doesn't deliver EOF-on-stdin the way POSIX shells do; the
      // shim may stay parked on the SIGINT/SIGTERM signal handler. Just
      // confirm we exited cleanly OR were SIGKILLed by afterEach.
      // TODO(2026-05-11): wire `child.kill('SIGTERM')` + assert SIGTERM
      // exit code once we can verify cosign-signed Windows runtime parity.
      // eslint-disable-next-line no-console
      console.warn(
        `[lifecycle.test] win32: skipped exit-code assertion (raw=${String(exitCode)})`,
      );
    } else {
      expect(exitCode).toBe(0);
    }
  }, 10_000);

  it('advertises exactly the 11-tool OpenClaw subset over real stdio MCP handshake', async () => {
    child = spawn(process.execPath, [BIN], {
      env: {
        ...process.env,
        MUHAVEN_BACKEND_URL: 'https://api-stage.muhaven.app',
        MUHAVEN_DASHBOARD_URL: 'http://localhost:7778',
        MUHAVEN_KEYRING: 'file',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const responses: Array<{ id?: number; result?: { tools?: Array<{ name: string }> } }> = [];
    readNdjsonResponses(child, (msg) => {
      responses.push(msg as typeof responses[number]);
    });

    function send(req: Record<string, unknown>): void {
      child!.stdin?.write(JSON.stringify(req) + '\n');
    }

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'lifecycle-test', version: '0' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

    const start = Date.now();
    let toolsResponse: typeof responses[number] | undefined;
    while (Date.now() - start < 5000) {
      toolsResponse = responses.find((m) => m.id === 2);
      if (toolsResponse) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    child.stdin?.end();

    if (!toolsResponse) {
      throw new Error(`tools/list timed out. stderr=${stderr || '(empty)'}`);
    }
    const advertised = (toolsResponse.result?.tools ?? []).map((t) => t.name).sort();
    expect(advertised).toEqual([...EXPECTED_TOOLS].sort());
  }, 10_000);

  it('responds to tools/call with a structured JSON-RPC frame (regression: bin can boot+list+call)', async () => {
    // H-3 coverage gap caught by 2026-05-11 pre-publish review: the
    // prior two cases prove the bin boots and `tools/list` returns 11
    // tools, but never exercise an actual `tools/call`. A regression
    // that breaks handler wire-up post-bundle (e.g., a future tsup
    // option dropping a request-handler import) would ship green
    // through CI without this case. We pick `muhaven.read.tokens`
    // because it's a `read.*` tool that's safe to call with no JWT —
    // the broker daemon won't be running in the test env, so the call
    // will land on an error response (auth/transport), but the *frame*
    // shape (well-formed JSON-RPC, id-matched) is the regression
    // guard. We assert the frame, not the specific error code.
    child = spawn(process.execPath, [BIN], {
      env: {
        ...process.env,
        MUHAVEN_BACKEND_URL: 'https://api-stage.muhaven.app',
        MUHAVEN_DASHBOARD_URL: 'http://localhost:7778',
        MUHAVEN_KEYRING: 'file',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const responses: Array<{
      jsonrpc?: string;
      id?: number;
      result?: { isError?: boolean; content?: unknown };
      error?: { code: number; message: string };
    }> = [];
    readNdjsonResponses(child, (msg) => {
      responses.push(msg as typeof responses[number]);
    });

    function send(req: Record<string, unknown>): void {
      child!.stdin?.write(JSON.stringify(req) + '\n');
    }

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'lifecycle-test', version: '0' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    send({
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: {
        name: 'muhaven.read.tokens',
        arguments: {},
      },
    });

    const start = Date.now();
    let callResponse: typeof responses[number] | undefined;
    while (Date.now() - start < 8000) {
      callResponse = responses.find((m) => m.id === 42);
      if (callResponse) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    child.stdin?.end();

    if (!callResponse) {
      throw new Error(`tools/call timed out. stderr=${stderr || '(empty)'}`);
    }
    // Well-formed JSON-RPC frame: jsonrpc=2.0 + matching id + exactly
    // one of {result, error}.
    expect(callResponse.jsonrpc).toBe('2.0');
    expect(callResponse.id).toBe(42);
    const hasResult = callResponse.result !== undefined;
    const hasError = callResponse.error !== undefined;
    expect(hasResult || hasError).toBe(true);
    expect(hasResult && hasError).toBe(false);
    // Either path is acceptable — what we're guarding is that the
    // bin returned ANY structured response instead of crashing or
    // emitting a malformed frame. The specific shape (result.isError
    // vs error.code === -32000 etc.) is upstream's contract and
    // would over-couple this regression test.
  }, 15_000);
});
