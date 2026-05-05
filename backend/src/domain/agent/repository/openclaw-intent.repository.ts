import type {
  OpenClawIntent,
  OpenClawIntentStatus,
} from '../model/openclaw-intent.js';

export interface IssueOpenClawIntentInput {
  intent: OpenClawIntent;
}

export interface ConfirmOpenClawIntentInput {
  intentId: string;
  userId: string;
  /** OTP supplied by the Mini App tier; null for tiers that don't require it. */
  otp?: string | null;
  now: Date;
}

export interface ConsumeOpenClawIntentInput {
  intentId: string;
  userId: string;
  now: Date;
}

export interface DenyOpenClawIntentInput {
  intentId: string;
  userId: string;
  reason?: string;
  now: Date;
}

/**
 * Persistence contract for OpenClaw confirmation intents.
 *
 * Implementations MUST:
 *  - Enforce status transitions atomically with conditional UPDATE
 *    (`WHERE status = expected`) — only one of `confirm`/`deny` can win
 *    on a concurrent race.
 *  - Sweep expired rows lazily on every lookup so callers never observe
 *    a stale `pending` past `expiresAt`.
 *  - Treat the intent log as audit material — no row deletion, only
 *    forward status flips. Wave 5 may add a hard-delete cron with a
 *    `>180d` retention window for GDPR.
 */
export interface IOpenClawIntentRepository {
  issue(input: IssueOpenClawIntentInput): Promise<void>;
  findById(intentId: string): Promise<OpenClawIntent | null>;
  /** Atomic confirm — succeeds only if the row is still `pending`. */
  confirm(input: ConfirmOpenClawIntentInput): Promise<OpenClawIntent | null>;
  /** Atomic consume — succeeds only if the row is `confirmed`. */
  consume(input: ConsumeOpenClawIntentInput): Promise<OpenClawIntent | null>;
  /** Atomic deny — succeeds only if the row is `pending`. */
  deny(input: DenyOpenClawIntentInput): Promise<OpenClawIntent | null>;
  /** Sweep `pending` rows past `expiresAt` to status=`expired`. */
  sweepExpired(now: Date): Promise<number>;
  /** Recent intents for a user (admin / audit). Cursor-paginated upstream. */
  findByUserId(
    userId: string,
    opts?: { status?: OpenClawIntentStatus; limit?: number },
  ): Promise<OpenClawIntent[]>;
}
