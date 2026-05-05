import type { AgentConfirmToken } from '../model/agent-confirm-token.js';

/**
 * Repository for single-use confirmation tokens (R-3). The contract is
 * narrow on purpose: issue, look up, atomically consume. No update, no
 * delete (expired tokens stay around for audit-log joining; a separate
 * reaper job can prune in Wave 5+).
 */
export interface IAgentConfirmTokenRepository {
  issue(token: AgentConfirmToken): Promise<void>;
  findByToken(token: string): Promise<AgentConfirmToken | null>;
  /**
   * Atomic conditional consume. Returns the consumed token on success
   * (so the caller has the action_payload), or `null` if the token did
   * not exist, was already consumed, was expired, or did not match the
   * `(userId, actionHash)` binding. Implementations MUST use a single
   * UPDATE … WHERE consumed_at IS NULL statement and check the row
   * count.
   */
  consume(token: string, userId: string, actionHash: string, now: Date): Promise<AgentConfirmToken | null>;
}
