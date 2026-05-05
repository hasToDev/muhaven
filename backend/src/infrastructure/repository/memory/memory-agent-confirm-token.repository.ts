import type { IAgentConfirmTokenRepository } from '../../../domain/agent/repository/agent-confirm-token.repository.js';
import { AgentConfirmToken } from '../../../domain/agent/model/agent-confirm-token.js';

export class MemoryAgentConfirmTokenRepository implements IAgentConfirmTokenRepository {
  private readonly store = new Map<string, AgentConfirmToken>();

  async issue(token: AgentConfirmToken): Promise<void> {
    this.store.set(token.token, token);
  }

  async findByToken(token: string): Promise<AgentConfirmToken | null> {
    return this.store.get(token) ?? null;
  }

  async consume(
    token: string,
    userId: string,
    actionHash: string,
    now: Date,
  ): Promise<AgentConfirmToken | null> {
    const existing = this.store.get(token);
    if (!existing) return null;
    if (existing.userId !== userId || existing.actionHash !== actionHash) return null;
    if (existing.consumedAt !== null) return null;
    if (existing.expiresAt.getTime() <= now.getTime()) return null;

    const consumed = new AgentConfirmToken({
      ...existing,
      actionKind: existing.actionKind,
      actionHash: existing.actionHash,
      actionPayload: existing.actionPayload,
      expiresAt: existing.expiresAt,
      createdAt: existing.createdAt,
      consumedAt: now,
    });
    this.store.set(token, consumed);
    return consumed;
  }
}
