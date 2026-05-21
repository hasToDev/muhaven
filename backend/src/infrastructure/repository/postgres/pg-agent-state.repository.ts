import { and, eq, inArray } from 'drizzle-orm';
import type { IAgentStateRepository } from '../../../domain/agent/repository/agent-state.repository.js';
import { AgentUserState } from '../../../domain/agent/model/agent-user-state.js';
import type { Surface } from '../../../domain/agent/model/surface.enum.js';
import type { Tier } from '../../../domain/agent/model/tier.enum.js';
import type { Trigger } from '../../../domain/agent/model/trigger.enum.js';
import { agentUserState } from './schema.js';
import type { Db } from './db.js';

export class PgAgentStateRepository implements IAgentStateRepository {
  constructor(private readonly db: Db) {}

  async findByUserAndSurface(userId: string, surface: Surface): Promise<AgentUserState | null> {
    const row = await this.db.query.agentUserState.findFirst({
      where: and(eq(agentUserState.userId, userId), eq(agentUserState.surface, surface)),
    });
    return row ? this.toDomain(row) : null;
  }

  async findAllForUser(userId: string): Promise<AgentUserState[]> {
    const rows = await this.db.query.agentUserState.findMany({
      where: eq(agentUserState.userId, userId),
    });
    return rows.map((r) => this.toDomain(r));
  }

  async findByTier(tier: Tier): Promise<AgentUserState[]> {
    const rows = await this.db.query.agentUserState.findMany({
      where: eq(agentUserState.tier, tier),
    });
    return rows.map((r) => this.toDomain(r));
  }

  async findByTiers(tiers: readonly Tier[]): Promise<AgentUserState[]> {
    if (tiers.length === 0) return [];
    const rows = await this.db.query.agentUserState.findMany({
      where: inArray(agentUserState.tier, tiers as Tier[]),
    });
    return rows.map((r) => this.toDomain(r));
  }

  async upsert(state: AgentUserState): Promise<void> {
    await this.db
      .insert(agentUserState)
      .values({
        userId: state.userId,
        surface: state.surface,
        tier: state.tier,
        pausedAt: state.pausedAt,
        pauseTrigger: state.pauseTrigger,
        pauseMetadata: state.pauseMetadata,
        enteredAt: state.enteredAt,
        validatorAddress: state.validatorAddress,
        confirmedActionCount: state.confirmedActionCount,
        riskQuestionnaireComplete: state.riskQuestionnaireComplete,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
      })
      .onConflictDoUpdate({
        target: [agentUserState.userId, agentUserState.surface],
        set: {
          tier: state.tier,
          pausedAt: state.pausedAt,
          pauseTrigger: state.pauseTrigger,
          pauseMetadata: state.pauseMetadata,
          enteredAt: state.enteredAt,
          validatorAddress: state.validatorAddress,
          confirmedActionCount: state.confirmedActionCount,
          riskQuestionnaireComplete: state.riskQuestionnaireComplete,
          updatedAt: state.updatedAt,
        },
      });
  }

  private toDomain(row: typeof agentUserState.$inferSelect): AgentUserState {
    return new AgentUserState({
      userId: row.userId,
      surface: row.surface as Surface,
      tier: row.tier as Tier,
      pausedAt: row.pausedAt ?? null,
      pauseTrigger: (row.pauseTrigger as Trigger | null) ?? null,
      pauseMetadata: (row.pauseMetadata as Record<string, unknown> | null) ?? null,
      enteredAt: row.enteredAt,
      validatorAddress: row.validatorAddress ?? null,
      confirmedActionCount: row.confirmedActionCount,
      riskQuestionnaireComplete: row.riskQuestionnaireComplete,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
}
