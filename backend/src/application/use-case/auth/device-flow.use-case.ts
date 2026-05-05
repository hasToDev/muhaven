import { randomBytes } from 'node:crypto';
import { ApplicationHttpError } from '../../../core/errors.js';
import type { IAgentDeviceCodeRepository } from '../../../domain/auth/repository/agent-device-code.repository.js';
import {
  AgentDeviceCode,
  DeviceCodeStatus,
  type RequesterMetadata,
} from '../../../domain/auth/model/agent-device-code.js';
import type { IUserRepository } from '../../../domain/auth/repository/user.repository.js';
import type { JwtService } from '../../../infrastructure/auth/jwt.service.js';

const CODE_TTL_SEC = 300; // 5 minutes per ADR-3 D4
const POLL_INTERVAL_SEC = 2;
// Crockford-style: removed letters that look like digits to keep the code typable.
// Exported so DTO + route guards derive the same regex from the same source —
// without this, lookup/authorize/dashboard each had their own loose regex
// (`[A-Z0-9]`) that accepted lookalike chars (O,I,0,1,L) the use-case
// itself would reject after .toUpperCase(), creating a small disclosure
// oracle between the lookup 200 and the authorize 400.
export const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ALPHABET_CLASS = USER_CODE_ALPHABET.split('').sort().join('');
export const USER_CODE_REGEX = new RegExp(`^[${ALPHABET_CLASS}]{4}-[${ALPHABET_CLASS}]{4}$`);

export const DEFAULT_MCP_SCOPE: readonly string[] = ['mcp.read.*', 'mcp.propose.*'];

export interface IssueDeviceCodeResult {
  deviceCode: string;
  userCode: string;
  expiresInSec: number;
  pollIntervalSec: number;
}

function genUserCode(): string {
  const buf = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) {
    s += USER_CODE_ALPHABET[buf[i] % USER_CODE_ALPHABET.length];
  }
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function genDeviceCode(): string {
  return randomBytes(32).toString('hex');
}

/**
 * `POST /api/v1/auth/device/code` — broker requests a fresh code pair.
 *
 * Rejects on `userCode` collision by retrying up to 3 times.
 */
export class IssueDeviceCodeUseCase {
  constructor(private readonly deviceCodeRepo: IAgentDeviceCodeRepository) {}

  async execute(metadata: RequesterMetadata, now: Date = new Date()): Promise<IssueDeviceCodeResult> {
    const expiresAt = new Date(now.getTime() + CODE_TTL_SEC * 1000);

    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const userCode = genUserCode();
      const deviceCode = genDeviceCode();
      try {
        await this.deviceCodeRepo.issue({
          deviceCode,
          userCode,
          requesterMetadata: metadata,
          expiresAt,
          now,
        });
        return {
          deviceCode,
          userCode,
          expiresInSec: CODE_TTL_SEC,
          pollIntervalSec: POLL_INTERVAL_SEC,
        };
      } catch (err) {
        // Only retry on a userCode-collision (PG unique violation 23505 on
        // `agent_device_codes_user_code_pending_idx` or the memory repo's
        // sentinel error). Re-raise everything else immediately so a
        // transient DB outage / jsonb validation failure / etc. doesn't
        // get masked as "astronomical bad luck on a 32^8 namespace".
        if (!isUserCodeCollision(err)) throw err;
        lastErr = err;
      }
    }
    throw new ApplicationHttpError(
      503,
      `failed to issue device code after retries: ${lastErr instanceof Error ? lastErr.message : ''}`,
    );
  }
}

/**
 * Recognises a userCode unique-constraint violation on the partial unique
 * index `agent_device_codes_user_code_pending_idx`. PG re-raises with
 * `code === '23505'`; the in-memory repo throws an Error whose message
 * starts with `userCode_collision:` to give the use-case a stable signal.
 */
function isUserCodeCollision(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown; constraint_name?: unknown };
  if (e.code === '23505') return true;
  if (typeof e.message === 'string' && e.message.startsWith('userCode_collision:')) return true;
  return false;
}

export interface AuthorizeDeviceCodeInput {
  userCode: string;
  userId: string;
  /** When true, deny the code instead of authorizing (user clicks "Cancel"). */
  deny?: boolean;
  denyReason?: string;
}

/**
 * `POST /api/v1/auth/device/authorize` — dashboard authenticates the user
 * (existing SIWE/JWT auth) and binds the user's identity to a userCode.
 *
 * Mints a scoped JWT (mcp.read.*, mcp.propose.*) on success.
 */
export class AuthorizeDeviceCodeUseCase {
  constructor(
    private readonly deviceCodeRepo: IAgentDeviceCodeRepository,
    private readonly userRepo: IUserRepository,
    private readonly jwtService: JwtService,
  ) {}

  async execute(input: AuthorizeDeviceCodeInput, now: Date = new Date()): Promise<{
    deviceCode: AgentDeviceCode;
  }> {
    const userCode = input.userCode.toUpperCase();
    if (!USER_CODE_REGEX.test(userCode)) {
      throw ApplicationHttpError.badRequest(
        'userCode must match XXXX-XXXX using the Crockford alphabet (no O/I/0/1/L)',
      );
    }

    // Collapse all "code is not authorizable now" cases into one
    // generic 400 so an attacker probing user codes can't distinguish
    // "doesn't exist" vs "already authorized" vs "expired" vs "denied".
    // This converts an oracle into noise + makes the brute-force budget
    // depend on online rate-limit only (see /authorize route's
    // withRateLimit middleware).
    const existing = await this.deviceCodeRepo.findByUserCode(userCode);
    const usable =
      existing &&
      existing.status === DeviceCodeStatus.Pending &&
      !existing.isExpired(now);
    if (!usable) {
      // Best-effort cleanup so subsequent legitimate /token polls see
      // the right state.
      if (existing && existing.isExpired(now)) {
        await this.deviceCodeRepo.sweepExpired(now);
      }
      throw ApplicationHttpError.badRequest('invalid or expired code');
    }

    if (input.deny) {
      const denied = await this.deviceCodeRepo.deny({
        userCode,
        userId: input.userId,
        reason: input.denyReason,
        now,
      });
      if (!denied) throw new ApplicationHttpError(409, 'deny race');
      return { deviceCode: denied };
    }

    const user = await this.userRepo.findById(input.userId);
    if (!user) throw ApplicationHttpError.notFound('user not found');

    const scope = [...DEFAULT_MCP_SCOPE];
    const payload = {
      sub: user.id,
      walletAddress: user.walletAddress,
      walletProvider: user.walletProvider,
      role: user.role,
    } as const;
    const token = await this.jwtService.generateScopedAccessToken(
      user.email !== undefined ? { ...payload, email: user.email } : payload,
      scope,
    );

    const updated = await this.deviceCodeRepo.authorize({
      userCode,
      userId: input.userId,
      jwt: token.accessToken,
      scope,
      now,
    });
    if (!updated) {
      // Lost a race — somebody else authorized / denied it.
      throw new ApplicationHttpError(409, 'authorize race');
    }
    return { deviceCode: updated };
  }
}

export type DeviceTokenPollState = 'pending' | 'authorized' | 'denied' | 'expired';

export interface PollDeviceTokenResult {
  state: DeviceTokenPollState;
  jwt?: string;
  scope?: string[];
  expiresAtSec?: number;
  reason?: string;
}

/**
 * `POST /api/v1/auth/device/token` — broker polls until JWT is ready.
 *
 * Atomic consume on `authorized` so the JWT is exposed exactly once.
 * Sweeps expired rows lazily on every poll to keep the state machine
 * consistent without a separate cron.
 */
export class PollDeviceTokenUseCase {
  constructor(private readonly deviceCodeRepo: IAgentDeviceCodeRepository) {}

  async execute(deviceCode: string, now: Date = new Date()): Promise<PollDeviceTokenResult> {
    if (!/^[a-f0-9]{64}$/.test(deviceCode)) {
      throw ApplicationHttpError.badRequest('deviceCode malformed');
    }
    await this.deviceCodeRepo.sweepExpired(now);

    const row = await this.deviceCodeRepo.findByDeviceCode(deviceCode);
    if (!row) {
      // Don't disclose existence — same shape as expired.
      return { state: 'expired' };
    }
    switch (row.status) {
      case DeviceCodeStatus.Pending:
        return { state: 'pending' };
      case DeviceCodeStatus.Authorized: {
        const consumed = await this.deviceCodeRepo.consume(deviceCode, now);
        if (!consumed) {
          // Race: somebody else consumed in the same millisecond.
          // Treat as already-authorized → device should NOT silently
          // succeed without a JWT. Return expired so the broker
          // re-issues.
          return { state: 'expired' };
        }
        return {
          state: 'authorized',
          jwt: consumed.jwt,
          scope: consumed.scope,
          expiresAtSec: undefined, // exp is in the JWT itself
        };
      }
      case DeviceCodeStatus.Denied:
        return { state: 'denied', ...(row.denyReason ? { reason: row.denyReason } : {}) };
      case DeviceCodeStatus.Expired:
      case DeviceCodeStatus.Consumed:
      default:
        return { state: 'expired' };
    }
  }
}
