import type { IAgentStateRepository } from '../../../../domain/agent/repository/agent-state.repository.js';
import { AgentUserState } from '../../../../domain/agent/model/agent-user-state.js';
import { Tier } from '../../../../domain/agent/model/tier.enum.js';
import { Surface, SURFACE_VALUES } from '../../../../domain/agent/model/surface.enum.js';

/**
 * Returns the current state for `userId × surface`. If a user has never
 * touched the surface, returns the default `Advisory` row without
 * persisting — write happens on first explicit transition.
 */
export class GetPolicyStateUseCase {
  constructor(private readonly stateRepo: IAgentStateRepository) {}

  async forSurface(userId: string, surface: Surface, now: Date = new Date()): Promise<AgentUserState> {
    const existing = await this.stateRepo.findByUserAndSurface(userId, surface);
    if (existing) return existing;
    return this.defaultStateFor(userId, surface, now);
  }

  async forAllSurfaces(userId: string, now: Date = new Date()): Promise<AgentUserState[]> {
    const existing = await this.stateRepo.findAllForUser(userId);
    const present = new Set(existing.map((s) => s.surface));
    const missing = SURFACE_VALUES.filter((s) => !present.has(s)).map((s) =>
      this.defaultStateFor(userId, s, now),
    );
    return [...existing, ...missing];
  }

  private defaultStateFor(userId: string, surface: Surface, now: Date): AgentUserState {
    return new AgentUserState({
      userId,
      surface,
      tier: Tier.Advisory,
      pausedAt: null,
      pauseTrigger: null,
      pauseMetadata: null,
      enteredAt: now,
      validatorAddress: null,
      confirmedActionCount: 0,
      riskQuestionnaireComplete: false,
      createdAt: now,
      updatedAt: now,
    });
  }
}
