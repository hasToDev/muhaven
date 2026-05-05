import type { AgentUserState } from '../model/agent-user-state.js';
import type { Surface } from '../model/surface.enum.js';
import type { Tier } from '../model/tier.enum.js';

export interface IAgentStateRepository {
  /**
   * Lookup by primary key `(userId, surface)`. Returns `null` if the user
   * has not interacted with that surface yet.
   */
  findByUserAndSurface(userId: string, surface: Surface): Promise<AgentUserState | null>;

  /**
   * All surface rows for a user — used by the cascade handler (T-5 KYC
   * revocation, T-6 account recovery) and the `GET /agent/policy/state`
   * route that returns one row per surface.
   */
  findAllForUser(userId: string): Promise<AgentUserState[]>;

  /**
   * Driver query for the cron policy engine. Filters on tier so the
   * engine never wakes users in `Advisory` or `ConfirmPerAction`.
   */
  findByTier(tier: Tier): Promise<AgentUserState[]>;

  /** Idempotent upsert. Caller passes the new entity; we replace the row. */
  upsert(state: AgentUserState): Promise<void>;
}
