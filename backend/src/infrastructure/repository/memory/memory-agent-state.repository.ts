import type { IAgentStateRepository } from '../../../domain/agent/repository/agent-state.repository.js';
import type { AgentUserState } from '../../../domain/agent/model/agent-user-state.js';
import type { Surface } from '../../../domain/agent/model/surface.enum.js';
import type { Tier } from '../../../domain/agent/model/tier.enum.js';

const key = (userId: string, surface: Surface) => `${userId}:${surface}`;

export class MemoryAgentStateRepository implements IAgentStateRepository {
  private readonly store = new Map<string, AgentUserState>();

  async findByUserAndSurface(userId: string, surface: Surface): Promise<AgentUserState | null> {
    return this.store.get(key(userId, surface)) ?? null;
  }

  async findAllForUser(userId: string): Promise<AgentUserState[]> {
    const out: AgentUserState[] = [];
    for (const v of this.store.values()) {
      if (v.userId === userId) out.push(v);
    }
    return out;
  }

  async findByTier(tier: Tier): Promise<AgentUserState[]> {
    const out: AgentUserState[] = [];
    for (const v of this.store.values()) {
      if (v.tier === tier) out.push(v);
    }
    return out;
  }

  async upsert(state: AgentUserState): Promise<void> {
    this.store.set(key(state.userId, state.surface), state);
  }
}
