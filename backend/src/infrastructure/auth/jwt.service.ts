import { SignJWT, jwtVerify } from 'jose';
import { getEnv } from '../../core/config.js';

export interface JwtTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
}

export interface JwtPayload {
  sub: string;
  walletAddress: string;
  walletProvider: string;
  role: string;
  email?: string;
  /** Wave 4 P3 ADR-3: scope claim added by `generateScopedAccessToken`. */
  scope?: string[];
}

export interface ScopedAccessToken {
  accessToken: string;
  expiresInSec: number;
  expiresAtSec: number;
}

export class JwtService {
  private readonly secret: Uint8Array;
  private readonly issuer: string;
  private readonly accessTokenTtl: number;
  private readonly refreshTokenTtl: number;

  constructor() {
    const env = getEnv();
    this.secret = new TextEncoder().encode(env.JWT_SECRET);
    this.issuer = env.JWT_ISSUER;
    this.accessTokenTtl = env.ACCESS_TOKEN_TTL;
    this.refreshTokenTtl = env.REFRESH_TOKEN_TTL;
  }

  async generateTokenPair(payload: JwtPayload): Promise<JwtTokenPair> {
    const now = Math.floor(Date.now() / 1000);

    const accessToken = await new SignJWT({
      walletAddress: payload.walletAddress,
      walletProvider: payload.walletProvider,
      role: payload.role,
      email: payload.email,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(payload.sub)
      .setIssuer(this.issuer)
      .setIssuedAt(now)
      .setExpirationTime(now + this.accessTokenTtl)
      .sign(this.secret);

    const refreshToken = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(payload.sub)
      .setIssuer(this.issuer)
      .setIssuedAt(now)
      .setExpirationTime(now + this.refreshTokenTtl)
      .sign(this.secret);

    return {
      accessToken,
      refreshToken,
      expiresIn: this.accessTokenTtl,
      refreshExpiresIn: this.refreshTokenTtl,
    };
  }

  /**
   * Mint a scoped access token for the device-flow path (Wave 4 P3 ADR-3).
   *
   * Differences from `generateTokenPair`:
   *   - Adds a `scope` claim (array of scope patterns).
   *   - Caller controls TTL — default 24h; capped at max(accessTokenTtl, 86_400)
   *     so device-flow tokens never out-live the dashboard's accessTokenTtl
   *     ceiling unless that ceiling is itself short.
   *   - No refresh token — re-acquisition runs the device-code flow again.
   *
   * `scope` patterns are matched by `withScope(...)` middleware. Wildcards
   * are dot-segmented (e.g., `mcp.read.*` matches `mcp.read.portfolio`).
   */
  async generateScopedAccessToken(
    payload: JwtPayload,
    scope: string[],
    ttlSec?: number,
  ): Promise<ScopedAccessToken> {
    const now = Math.floor(Date.now() / 1000);
    const ceiling = Math.max(this.accessTokenTtl, 86_400);
    const ttl = Math.min(ttlSec ?? 86_400, ceiling);

    const accessToken = await new SignJWT({
      walletAddress: payload.walletAddress,
      walletProvider: payload.walletProvider,
      role: payload.role,
      email: payload.email,
      scope,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(payload.sub)
      .setIssuer(this.issuer)
      .setIssuedAt(now)
      .setExpirationTime(now + ttl)
      .sign(this.secret);

    return { accessToken, expiresInSec: ttl, expiresAtSec: now + ttl };
  }

  async verifyAccessToken(token: string): Promise<JwtPayload> {
    const { payload } = await jwtVerify(token, this.secret, {
      issuer: this.issuer,
    });

    const result: JwtPayload = {
      sub: payload.sub!,
      walletAddress: payload.walletAddress as string,
      walletProvider: payload.walletProvider as string,
      role: payload.role as string,
      email: payload.email as string | undefined,
    };
    if (Array.isArray(payload.scope)) {
      result.scope = (payload.scope as unknown[]).filter((s): s is string => typeof s === 'string');
    }
    return result;
  }

  async verifyRefreshToken(token: string): Promise<{ sub: string }> {
    const { payload } = await jwtVerify(token, this.secret, {
      issuer: this.issuer,
    });

    return { sub: payload.sub! };
  }
}
