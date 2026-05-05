import { createHmac } from 'node:crypto';

/**
 * Telegram Mini App initData verification (Wave 4 P4).
 *
 * Per the official Telegram WebApp protocol (telegram.org/bots/webapps#
 * validating-data-received-via-the-web-app), the Mini App receives a
 * `tgWebAppData` parameter (URL-encoded query string) that includes a
 * `hash` field. The backend verifies the hash by:
 *
 *   1. Removing `hash` and any string starting with `tgWebAppData_*` from
 *      the parameter list.
 *   2. Sorting the remaining params by key.
 *   3. Joining as `key=value\n`.
 *   4. Computing HMAC-SHA256 of the joined string with key
 *      `HMAC-SHA256("WebAppData", botToken)`.
 *   5. Comparing to the supplied `hash` (constant-time).
 *
 * The verification also returns the parsed `auth_date` so the caller can
 * enforce a freshness window (Mini App init data older than ~24h should
 * be rejected to defeat replay).
 *
 * No external Telegram SDK required — the algorithm is a stable spec.
 */

const TELEGRAM_INIT_DATA_MAX_AGE_SEC = 24 * 60 * 60; // 24h
const TELEGRAM_HMAC_KEY_LITERAL = 'WebAppData';

export interface VerifiedTelegramInitData {
  /** chat / user id from the verified `user.id` field. */
  userId: string;
  /** Telegram username (nullable in Telegram's protocol). */
  username: string | null;
  /** auth_date as Unix epoch seconds. */
  authDateSec: number;
  /** Raw user object (for downstream display). */
  user: TelegramUserObject;
  /** Optional `start_param` — Mini App was launched with a deep-link param. */
  startParam: string | null;
}

export interface TelegramUserObject {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export class TelegramInitDataInvalidError extends Error {
  constructor(
    public readonly code: 'malformed' | 'hash_mismatch' | 'stale' | 'no_user',
    message: string,
  ) {
    super(message);
    this.name = 'TelegramInitDataInvalidError';
  }
}

export interface TelegramInitDataVerifierOpts {
  botToken: string;
  /** Override max age in tests; production uses the 24h default. */
  maxAgeSec?: number;
  /** Inject a clock for tests; production uses Date.now. */
  now?: () => Date;
}

export class TelegramInitDataVerifier {
  private readonly botToken: string;
  private readonly maxAgeSec: number;
  private readonly now: () => Date;

  constructor(opts: TelegramInitDataVerifierOpts) {
    if (!opts.botToken || opts.botToken.length < 16) {
      throw new Error('TelegramInitDataVerifier: botToken is required');
    }
    this.botToken = opts.botToken;
    this.maxAgeSec = opts.maxAgeSec ?? TELEGRAM_INIT_DATA_MAX_AGE_SEC;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Verify the URL-encoded initData string. Returns parsed user info on
   * success; throws `TelegramInitDataInvalidError` otherwise.
   *
   * The input is the literal value of `Telegram.WebApp.initData` (a
   * URL-encoded query string), NOT the parsed object — parsing on the
   * server side ensures we use canonical encoding before HMAC.
   */
  verify(initDataRaw: string): VerifiedTelegramInitData {
    if (typeof initDataRaw !== 'string' || initDataRaw.length === 0) {
      throw new TelegramInitDataInvalidError('malformed', 'initData empty');
    }

    let params: URLSearchParams;
    try {
      params = new URLSearchParams(initDataRaw);
    } catch (e) {
      throw new TelegramInitDataInvalidError(
        'malformed',
        `failed to parse initData: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    }

    const suppliedHash = params.get('hash');
    if (!suppliedHash || !/^[a-f0-9]{64}$/.test(suppliedHash)) {
      throw new TelegramInitDataInvalidError('malformed', 'hash field missing or malformed');
    }

    // Build the data-check string per spec: drop `hash`, sort remaining
    // by key, join `key=value\n`. Also drop any `tgWebAppData_*` per
    // spec-creep: future-compat reserved fields.
    const pairs: { key: string; value: string }[] = [];
    for (const [k, v] of params.entries()) {
      if (k === 'hash') continue;
      if (k.startsWith('tgWebAppData_')) continue;
      pairs.push({ key: k, value: v });
    }
    pairs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const dataCheck = pairs.map((p) => `${p.key}=${p.value}`).join('\n');

    const secretKey = createHmac('sha256', TELEGRAM_HMAC_KEY_LITERAL)
      .update(this.botToken)
      .digest();
    const computedHash = createHmac('sha256', secretKey)
      .update(dataCheck)
      .digest('hex');

    // Use timing-safe equal — both 64 hex chars, equal length asserted above.
    if (!constantTimeEqual(suppliedHash, computedHash)) {
      throw new TelegramInitDataInvalidError('hash_mismatch', 'hash verification failed');
    }

    const authDateRaw = params.get('auth_date');
    if (!authDateRaw || !/^\d+$/.test(authDateRaw)) {
      throw new TelegramInitDataInvalidError('malformed', 'auth_date missing or malformed');
    }
    const authDateSec = Number.parseInt(authDateRaw, 10);
    const nowSec = Math.floor(this.now().getTime() / 1000);
    if (nowSec - authDateSec > this.maxAgeSec) {
      throw new TelegramInitDataInvalidError(
        'stale',
        `initData is older than ${this.maxAgeSec}s`,
      );
    }

    const userRaw = params.get('user');
    if (!userRaw) {
      throw new TelegramInitDataInvalidError('no_user', 'user field missing');
    }
    let user: TelegramUserObject;
    try {
      user = JSON.parse(userRaw) as TelegramUserObject;
    } catch (e) {
      throw new TelegramInitDataInvalidError(
        'malformed',
        `user field is not valid JSON: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    }
    if (typeof user?.id !== 'number') {
      throw new TelegramInitDataInvalidError('no_user', 'user.id is not a number');
    }

    const startParam = params.get('start_param');

    return {
      userId: user.id.toString(),
      username: user.username ?? null,
      authDateSec,
      user,
      startParam,
    };
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
