import type { AgentCronState } from '../model/agent-cron-state.js';

export interface IAgentCronStateRepository {
  /** Returns null when the engine has never ticked yet. */
  findById(id: string): Promise<AgentCronState | null>;
  upsert(state: AgentCronState): Promise<void>;
}
