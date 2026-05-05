import { and, eq, gt, isNull } from 'drizzle-orm';
import type { IAgentConfirmTokenRepository } from '../../../domain/agent/repository/agent-confirm-token.repository.js';
import {
  AgentConfirmToken,
  type ConfirmTokenActionKind,
} from '../../../domain/agent/model/agent-confirm-token.js';
import { agentConfirmTokens } from './schema.js';
import type { Db } from './db.js';

export class PgAgentConfirmTokenRepository implements IAgentConfirmTokenRepository {
  constructor(private readonly db: Db) {}

  async issue(token: AgentConfirmToken): Promise<void> {
    await this.db.insert(agentConfirmTokens).values({
      token: token.token,
      userId: token.userId,
      actionKind: token.actionKind,
      actionHash: token.actionHash,
      actionPayload: token.actionPayload,
      expiresAt: token.expiresAt,
      consumedAt: token.consumedAt,
      createdAt: token.createdAt,
    });
  }

  async findByToken(token: string): Promise<AgentConfirmToken | null> {
    const row = await this.db.query.agentConfirmTokens.findFirst({
      where: eq(agentConfirmTokens.token, token),
    });
    return row ? this.toDomain(row) : null;
  }

  async consume(
    token: string,
    userId: string,
    actionHash: string,
    now: Date,
  ): Promise<AgentConfirmToken | null> {
    // Atomic conditional consume: only succeeds if the row matches
    // (token, userId, actionHash), is unconsumed, and is not expired.
    // Returning the full row tells us in one round-trip whether the
    // consume actually applied.
    const updated = await this.db
      .update(agentConfirmTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(agentConfirmTokens.token, token),
          eq(agentConfirmTokens.userId, userId),
          eq(agentConfirmTokens.actionHash, actionHash),
          isNull(agentConfirmTokens.consumedAt),
          gt(agentConfirmTokens.expiresAt, now),
        ),
      )
      .returning();

    if (updated.length === 0) return null;
    return this.toDomain(updated[0]);
  }

  private toDomain(row: typeof agentConfirmTokens.$inferSelect): AgentConfirmToken {
    return new AgentConfirmToken({
      token: row.token,
      userId: row.userId,
      actionKind: row.actionKind as ConfirmTokenActionKind,
      actionHash: row.actionHash,
      actionPayload: (row.actionPayload as Record<string, unknown>) ?? {},
      expiresAt: row.expiresAt,
      consumedAt: row.consumedAt ?? null,
      createdAt: row.createdAt,
    });
  }
}
