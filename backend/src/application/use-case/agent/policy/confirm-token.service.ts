import { createHash, randomBytes } from 'crypto';
import type { IAgentConfirmTokenRepository } from '../../../../domain/agent/repository/agent-confirm-token.repository.js';
import {
  AgentConfirmToken,
  type ConfirmTokenActionKind,
} from '../../../../domain/agent/model/agent-confirm-token.js';
import { ApplicationHttpError } from '../../../../core/errors.js';

/** 5-minute confirmation TTL — matches the DEV_LOG R-3 ceiling for replay
 * resistance and the ZeroDev session-key `validUntil` cap discussed in
 * `WAVE_PLAN.md` R-3 row. */
const DEFAULT_CONFIRM_TTL_MS = 5 * 60 * 1000;

export interface IssueConfirmTokenInput {
  userId: string;
  actionKind: ConfirmTokenActionKind;
  actionPayload: Record<string, unknown>;
  ttlMs?: number;
  now?: Date;
}

export interface IssueConfirmTokenResult {
  token: string;
  actionHash: string;
  expiresAt: Date;
}

/**
 * Single-use confirmation tokens — R-3 mitigation. Centralized so the
 * `(actionKind, actionPayload) → actionHash` derivation is consistent
 * across every issue/consume call site (pause / transition / permit).
 *
 * The hash uses `JSON.stringify` with sorted keys so semantically equal
 * payloads produce identical hashes — re-approving the same action is
 * deterministic, but the slightest change forces a fresh confirmation.
 */
export class ConfirmTokenService {
  constructor(private readonly tokenRepo: IAgentConfirmTokenRepository) {}

  async issue(input: IssueConfirmTokenInput): Promise<IssueConfirmTokenResult> {
    const ttl = input.ttlMs ?? DEFAULT_CONFIRM_TTL_MS;
    const now = input.now ?? new Date();
    const token = randomBytes(32).toString('hex');
    const actionHash = ConfirmTokenService.hashAction(input.actionKind, input.actionPayload);
    const expiresAt = new Date(now.getTime() + ttl);

    await this.tokenRepo.issue(
      new AgentConfirmToken({
        token,
        userId: input.userId,
        actionKind: input.actionKind,
        actionHash,
        actionPayload: input.actionPayload,
        expiresAt,
        consumedAt: null,
        createdAt: now,
      }),
    );

    return { token, actionHash, expiresAt };
  }

  /**
   * Consume a token. Throws `ApplicationHttpError(410)` when the token has
   * already been consumed or expired (R-3 replay rejection); 403 when the
   * token does not exist or does not match the `(userId, actionKind,
   * actionPayload)` tuple.
   */
  async consume(
    token: string,
    userId: string,
    actionKind: ConfirmTokenActionKind,
    actionPayload: Record<string, unknown>,
    now: Date = new Date(),
  ): Promise<AgentConfirmToken> {
    const actionHash = ConfirmTokenService.hashAction(actionKind, actionPayload);
    const consumed = await this.tokenRepo.consume(token, userId, actionHash, now);

    if (consumed) return consumed;

    // Differentiate "wrong binding" from "already consumed / expired" so
    // the route handler can return a precise status. Two-step look-up is
    // cheap on the rare failure path; the happy path is the single
    // conditional UPDATE above.
    const existing = await this.tokenRepo.findByToken(token);
    if (!existing || existing.userId !== userId || existing.actionHash !== actionHash) {
      throw ApplicationHttpError.forbidden('Invalid confirmation token');
    }
    if (existing.consumedAt !== null) {
      throw new ApplicationHttpError(410, 'Confirmation token already consumed');
    }
    if (existing.expiresAt.getTime() <= now.getTime()) {
      throw new ApplicationHttpError(410, 'Confirmation token expired');
    }

    // Reaching here means the conditional UPDATE failed for a reason the
    // follow-up read couldn't reproduce — defensive default.
    throw new ApplicationHttpError(410, 'Confirmation token rejected');
  }

  static hashAction(actionKind: ConfirmTokenActionKind, actionPayload: Record<string, unknown>): string {
    const stable = stableStringify({ kind: actionKind, payload: actionPayload });
    return createHash('sha256').update(stable, 'utf-8').digest('hex');
  }
}

/**
 * Deterministic stringifier: sorts object keys alphabetically at every
 * depth so two semantically equal payloads always produce the same hash.
 * Arrays preserve order.
 */
function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',') + '}';
}
