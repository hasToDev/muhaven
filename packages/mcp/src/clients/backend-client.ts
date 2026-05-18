/**
 * Thin REST client for the MuHaven backend. The backend exposes JWT-
 * authenticated endpoints under `/api/v1/...`; this client carries the
 * caller's bearer token on every request and surfaces errors as
 * `BackendError` with stable codes.
 *
 * **JWT acquisition**: per ADR-3, the JWT is fetched from a `JwtSource`
 * (which is broker-mediated). On a 401 response the client invalidates
 * the JWT cache once and retries; if the second 401 lands, surface
 * `BackendError(unauthorized)` to the caller — that's the device-flow
 * trigger.
 *
 * **URL guard**: every request URL is checked against the configured
 * allowed-host allowlist. Defends against (Wave-5) prompt-injection
 * coercing the LLM into a host-swap. Today the tool layer hard-codes
 * paths so the guard is belt-and-suspenders, but defining it here means
 * the guarantee survives later refactors.
 */

import type { JwtSource } from '../auth/jwt-source.js';

export interface BackendClientOptions {
  baseUrl: string;
  jwtSource: JwtSource;
  timeoutMs: number;
  allowedHosts: readonly string[];
  /** Inject a fetch impl for tests. */
  fetchImpl?: typeof fetch;
}

export type BackendErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'gone'
  | 'rate_limited'
  | 'bad_request'
  | 'server_error'
  | 'network'
  | 'timeout'
  | 'invalid_response'
  | 'host_not_allowed';

export class BackendError extends Error {
  constructor(
    readonly code: BackendErrorCode,
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

export class BackendClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: BackendClientOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const url = this.buildUrl(path, query);
    return this.exchangeWithRetry<T>('GET', url);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const url = this.buildUrl(path);
    return this.exchangeWithRetry<T>('POST', url, body);
  }

  /**
   * Path-less variant for unauthenticated calls (e.g., device-code
   * flow's `/auth/device/code` and `/auth/device/token`). Sends no
   * Authorization header.
   */
  async postUnauth<T>(path: string, body: unknown): Promise<T> {
    const url = this.buildUrl(path);
    return this.exchange<T>('POST', url, body, /* withAuth */ false);
  }

  /**
   * GET variant that sends no Authorization header. Use for backend
   * endpoints that are intentionally public (e.g. `/api/v1/tokens`
   * which the marketplace + the 0.2.1 `positionBuy` NAV-conversion
   * both read). Avoids triggering the AUTH_REQUIRED branch for the
   * "not yet logged in" case on read paths that don't need auth.
   */
  async getUnauth<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const url = this.buildUrl(path, query);
    return this.exchange<T>('GET', url, undefined, /* withAuth */ false);
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): URL {
    if (!path.startsWith('/')) {
      throw new BackendError('bad_request', `path must start with "/": ${path}`);
    }
    const url = new URL(this.options.baseUrl + path);
    if (!this.options.allowedHosts.includes(url.host)) {
      throw new BackendError(
        'host_not_allowed',
        `request host ${url.host} not in allowedHosts`,
      );
    }
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }
    return url;
  }

  private async exchangeWithRetry<T>(method: string, url: URL, body?: unknown): Promise<T> {
    try {
      return await this.exchange<T>(method, url, body, true);
    } catch (err) {
      if (err instanceof BackendError && err.code === 'unauthorized') {
        // One retry after refreshing JWT — covers stale-cache races.
        this.options.jwtSource.invalidate();
        return this.exchange<T>(method, url, body, true);
      }
      throw err;
    }
  }

  private async exchange<T>(
    method: string,
    url: URL,
    body: unknown,
    withAuth: boolean,
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    };
    if (withAuth) {
      const jwt = await this.options.jwtSource.get();
      headers.authorization = `Bearer ${jwt}`;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.options.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === 'AbortError') {
        throw new BackendError('timeout', `${method} ${url.pathname} timed out`);
      }
      throw new BackendError('network', `${method} ${url.pathname} network error`, undefined, err);
    } finally {
      clearTimeout(timer);
    }

    const status = res.status;
    const contentType = res.headers.get('content-type') ?? '';
    let payload: unknown = undefined;
    if (contentType.includes('application/json')) {
      try {
        payload = await res.json();
      } catch {
        // leave undefined
      }
    } else {
      try {
        payload = await res.text();
      } catch {
        // ignore
      }
    }

    if (status >= 200 && status < 300) {
      return payload as T;
    }

    throw new BackendError(
      mapStatus(status),
      `${method} ${url.pathname} → ${status}`,
      status,
      payload,
    );
  }
}

function mapStatus(status: number): BackendErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 410) return 'gone';
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500) return 'bad_request';
  if (status >= 500) return 'server_error';
  return 'invalid_response';
}
