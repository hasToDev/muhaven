import type { IAgentCronStateRepository } from '../../../domain/agent/repository/agent-cron-state.repository.js';
import type { AgentCronState } from '../../../domain/agent/model/agent-cron-state.js';

export class MemoryAgentCronStateRepository implements IAgentCronStateRepository {
  private readonly store = new Map<string, AgentCronState>();

  async findById(id: string): Promise<AgentCronState | null> {
    return this.store.get(id) ?? null;
  }

  async upsert(state: AgentCronState): Promise<void> {
    this.store.set(state.id, state);
  }
}
