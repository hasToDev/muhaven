/**
 * JWT source for the MCP server. Wraps `BrokerClient.getJwt()` with a
 * brief in-process cache (default 30s; tunable via
 * `MUHAVEN_JWT_CACHE_TTL_SEC`) so the per-tool-call hot path doesn't
 * round-trip the broker socket on every invocation.
 *
 * The cache is invalidated on:
 *  - Explicit `invalidate()` (called on backend-side 401 responses).
 *  - JWT expiry (when the broker recorded an `expiresAtSec`).
 *
 * On a cache miss, the source asks the broker via IPC. If the broker
 * returns `jwt: null`, the caller (tool handler / device-flow client)
 * is responsible for kicking off the device-flow ceremony — this module
 * never speaks HTTPS itself.
 */

import type { BrokerClient } from '../clients/broker-client.js';
import { BrokerClientError } from '../clients/broker-client.js';

export class NoJwtAvailableError extends Error {
  readonly code = 'no_jwt';
  constructor() {
    super(
      'No JWT in broker keystore — run `muhaven-broker login` to authenticate via the device-code flow.',
    );
    this.name = 'NoJwtAvailableError';
  }
}

export class JwtSource {
  private cached: { jwt: string; expiresAtSec: number | null; cachedAtMs: number } | null = null;

  constructor(
    private readonly broker: BrokerClient,
    private readonly cacheTtlSec: number,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  /**
   * Fetch the current JWT, throwing `NoJwtAvailableError` when the
   * broker keystore is empty.
   */
  async get(): Promise<string> {
    const cached = this.cachedJwtIfValid();
    if (cached !== null) return cached;

    let res;
    try {
      res = await this.broker.getJwt();
    } catch (err) {
      // Surface broker connect errors as-is — host can decide retry policy.
      if (err instanceof BrokerClientError) throw err;
      throw err;
    }

    if (!res.jwt) {
      this.cached = null;
      throw new NoJwtAvailableError();
    }
    this.cached = {
      jwt: res.jwt,
      expiresAtSec: res.expiresAtSec,
      cachedAtMs: this.nowMs(),
    };
    return res.jwt;
  }

  /** Drop the in-process cache. Call after a backend 401 to force refresh. */
  invalidate(): void {
    this.cached = null;
  }

  /** Returns the cached JWT iff it's fresh AND not past `expiresAtSec`. */
  private cachedJwtIfValid(): string | null {
    if (!this.cached) return null;
    const ageMs = this.nowMs() - this.cached.cachedAtMs;
    if (ageMs > this.cacheTtlSec * 1000) return null;
    if (this.cached.expiresAtSec !== null) {
      const nowSec = Math.floor(this.nowMs() / 1000);
      // Pad 30s to avoid handing out a token that expires mid-call.
      if (this.cached.expiresAtSec - nowSec < 30) return null;
    }
    return this.cached.jwt;
  }
}
