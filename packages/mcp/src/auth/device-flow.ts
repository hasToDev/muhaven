/**
 * RFC 8628-flavored device authorization grant client.
 *
 * Per ADR-3 D1, the broker is zero-egress — so the device-flow HTTPS
 * traffic happens here in the MCP package's process space (the
 * `muhaven-broker login` CLI invokes this; once a JWT is acquired it
 * is handed to the broker over IPC via `BrokerClient.storeJwt`).
 *
 * Three backend endpoints involved:
 *   POST /api/v1/auth/device/code     — broker requests a code
 *   POST /api/v1/auth/device/authorize — dashboard authorizes (NOT called here)
 *   POST /api/v1/auth/device/token    — broker polls for the JWT
 */

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 5 * 60 * 1000;

export interface DeviceCodeIssued {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresInSec: number;
  pollIntervalSec: number;
}

export interface DeviceFlowOptions {
  backendBaseUrl: string;
  dashboardBaseUrl: string;
  /** Optional describer for the request, displayed on the /link page. */
  requesterMetadata?: {
    processName?: string;
    hostname?: string;
    os?: string;
  };
  /** Inject a fetch impl for tests. */
  fetchImpl?: typeof fetch;
  /** Inject a sleeper for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Inject a clock for tests. */
  nowMs?: () => number;
}

export type DeviceFlowEvent =
  | { type: 'code_issued'; code: DeviceCodeIssued }
  | { type: 'polling'; attempt: number; nextPollMs: number }
  | { type: 'authorized'; jwt: string; expiresAtSec: number | null; scope: string[] | null }
  | { type: 'denied'; reason?: string }
  | { type: 'expired' };

export type DeviceFlowError =
  | { code: 'network'; cause: unknown }
  | { code: 'rate_limited' }
  | { code: 'invalid_response'; status?: number; body?: unknown }
  | { code: 'denied'; reason?: string }
  | { code: 'expired' }
  | { code: 'timeout' };

export class DeviceFlowAbortedError extends Error {
  constructor(readonly detail: DeviceFlowError) {
    super(`device flow aborted: ${detail.code}`);
    this.name = 'DeviceFlowAbortedError';
  }
}

interface DeviceTokenResponse {
  state: 'pending' | 'authorized' | 'denied' | 'expired';
  jwt?: string;
  scope?: string[];
  expiresAtSec?: number;
  reason?: string;
}

export class DeviceFlowClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly nowMs: () => number;

  constructor(private readonly options: DeviceFlowOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  /**
   * Run the full ceremony: request a code, yield events for the caller
   * to display the URL, then poll until authorized / denied / expired.
   * Throws `DeviceFlowAbortedError` on terminal failure.
   */
  async *run(opts?: { overallTimeoutMs?: number }): AsyncGenerator<
    DeviceFlowEvent,
    { jwt: string; expiresAtSec: number | null; scope: string[] | null },
    void
  > {
    const overallTimeout = opts?.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS;
    const code = await this.requestCode();
    yield { type: 'code_issued', code };

    const startedAt = this.nowMs();
    const pollMs = Math.max(1, code.pollIntervalSec) * 1000;
    let attempt = 0;

    while (this.nowMs() - startedAt < overallTimeout) {
      attempt += 1;
      yield { type: 'polling', attempt, nextPollMs: pollMs };
      await this.sleep(pollMs);
      const res = await this.pollOnce(code.deviceCode);
      switch (res.state) {
        case 'pending':
          continue;
        case 'authorized':
          if (!res.jwt) {
            throw new DeviceFlowAbortedError({
              code: 'invalid_response',
              body: { reason: 'authorized state missing jwt' },
            });
          }
          yield {
            type: 'authorized',
            jwt: res.jwt,
            expiresAtSec: res.expiresAtSec ?? null,
            scope: res.scope ?? null,
          };
          return {
            jwt: res.jwt,
            expiresAtSec: res.expiresAtSec ?? null,
            scope: res.scope ?? null,
          };
        case 'denied':
          yield { type: 'denied', reason: res.reason };
          throw new DeviceFlowAbortedError({ code: 'denied', reason: res.reason });
        case 'expired':
          yield { type: 'expired' };
          throw new DeviceFlowAbortedError({ code: 'expired' });
      }
    }
    throw new DeviceFlowAbortedError({ code: 'timeout' });
  }

  private async requestCode(): Promise<DeviceCodeIssued> {
    const url = new URL('/api/v1/auth/device/code', this.options.backendBaseUrl);
    const requesterMetadata = {
      processName: this.options.requesterMetadata?.processName ?? 'muhaven-broker',
      hostname: this.options.requesterMetadata?.hostname ?? '',
      os: this.options.requesterMetadata?.os ?? '',
    };
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ requesterMetadata }),
      });
    } catch (err) {
      throw new DeviceFlowAbortedError({ code: 'network', cause: err });
    }

    if (res.status === 429) {
      throw new DeviceFlowAbortedError({ code: 'rate_limited' });
    }
    if (res.status >= 400) {
      const body = await safeJson(res);
      throw new DeviceFlowAbortedError({ code: 'invalid_response', status: res.status, body });
    }
    const body = (await safeJson(res)) as Partial<{
      deviceCode: string;
      userCode: string;
      expiresInSec: number;
      pollIntervalSec: number;
    }>;
    if (!body || !body.deviceCode || !body.userCode) {
      throw new DeviceFlowAbortedError({ code: 'invalid_response', status: res.status, body });
    }
    const verificationUri = `${trim(this.options.dashboardBaseUrl)}/link`;
    const verificationUriComplete = `${verificationUri}?code=${encodeURIComponent(body.userCode)}`;
    return {
      deviceCode: body.deviceCode,
      userCode: body.userCode,
      verificationUri,
      verificationUriComplete,
      expiresInSec: body.expiresInSec ?? 300,
      pollIntervalSec: body.pollIntervalSec ?? Math.floor(DEFAULT_POLL_INTERVAL_MS / 1000),
    };
  }

  private async pollOnce(deviceCode: string): Promise<DeviceTokenResponse> {
    const url = new URL('/api/v1/auth/device/token', this.options.backendBaseUrl);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ deviceCode }),
      });
    } catch (err) {
      throw new DeviceFlowAbortedError({ code: 'network', cause: err });
    }
    if (res.status === 429) {
      // Backend says back off — don't escalate, the next loop iteration
      // will sleep and retry within the overall budget.
      return { state: 'pending' };
    }
    const body = (await safeJson(res)) as Partial<DeviceTokenResponse> | null;
    if (!body || typeof body.state !== 'string') {
      throw new DeviceFlowAbortedError({ code: 'invalid_response', status: res.status, body });
    }
    return body as DeviceTokenResponse;
  }
}

function trim(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
