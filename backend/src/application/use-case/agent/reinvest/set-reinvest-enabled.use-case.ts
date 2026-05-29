import { ApplicationHttpError } from '../../../../core/errors.js';
import { Surface } from '../../../../domain/agent/model/surface.enum.js';
import type { ScopedSession } from '../../../../domain/agent/model/scoped-session.js';
import type { IScopedSessionRepository } from '../../../../domain/agent/repository/scoped-session.repository.js';

/**
 * Wave 5 Slice 2 (auto-reinvest) — toggle the `reinvest_enabled` opt-in on
 * the user's active MCP Scoped session. Driven by the frontend Autonomy
 * toggle. The headless `should-run` gate reads the flag; flipping it OFF
 * is the user's kill-switch for auto-reinvest (independent of revoking
 * the whole session). 404 when there's no active session to toggle.
 */
export interface SetReinvestEnabledInput {
  readonly userId: string;
  readonly enabled: boolean;
  readonly now?: Date;
}

export class SetReinvestEnabledUseCase {
  constructor(private readonly scopedRepo: IScopedSessionRepository) {}

  async execute(input: SetReinvestEnabledInput): Promise<ScopedSession> {
    const now = input.now ?? new Date();
    const updated = await this.scopedRepo.setReinvestEnabled(
      input.userId,
      Surface.MCP,
      input.enabled,
      now,
    );
    if (!updated) {
      throw new ApplicationHttpError(
        404,
        'no active Scoped session to toggle auto-reinvest on — mint a Scoped session on the Autonomy page first',
      );
    }
    return updated;
  }
}
