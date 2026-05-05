import { eq } from 'drizzle-orm';
import type { IAgentCronStateRepository } from '../../../domain/agent/repository/agent-cron-state.repository.js';
import { AgentCronState } from '../../../domain/agent/model/agent-cron-state.js';
import { agentCronState } from './schema.js';
import type { Db } from './db.js';

export class PgAgentCronStateRepository implements IAgentCronStateRepository {
  constructor(private readonly db: Db) {}

  async findById(id: string): Promise<AgentCronState | null> {
    const row = await this.db.query.agentCronState.findFirst({
      where: eq(agentCronState.id, id),
    });
    return row ? this.toDomain(row) : null;
  }

  async upsert(state: AgentCronState): Promise<void> {
    await this.db
      .insert(agentCronState)
      .values({
        id: state.id,
        lastTickAt: state.lastTickAt,
        lastTickUserCount: state.lastTickUserCount,
        lastTickBreachCount: state.lastTickBreachCount,
        lastTickError: state.lastTickError,
        updatedAt: state.updatedAt,
      })
      .onConflictDoUpdate({
        target: agentCronState.id,
        set: {
          lastTickAt: state.lastTickAt,
          lastTickUserCount: state.lastTickUserCount,
          lastTickBreachCount: state.lastTickBreachCount,
          lastTickError: state.lastTickError,
          updatedAt: state.updatedAt,
        },
      });
  }

  private toDomain(row: typeof agentCronState.$inferSelect): AgentCronState {
    return new AgentCronState({
      id: row.id,
      lastTickAt: row.lastTickAt ?? null,
      lastTickUserCount: row.lastTickUserCount ?? null,
      lastTickBreachCount: row.lastTickBreachCount ?? null,
      lastTickError: row.lastTickError ?? null,
      updatedAt: row.updatedAt,
    });
  }
}
