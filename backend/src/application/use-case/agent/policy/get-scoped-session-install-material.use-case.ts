import type { ScopedSessionInstallMaterial } from '../../../../domain/agent/model/scoped-session.js';
import type { IScopedSessionRepository } from '../../../../domain/agent/repository/scoped-session.repository.js';

/**
 * Wave 5 Option D · Commit 2 — install-material lookup for the broker
 * callback subroute.
 *
 *   GET /api/v1/agent/policy/scoped-session/:sessionId/install-material?userId=...
 *
 * Caller: the C3 MCP server, when its Path D probe sees
 * `enable_status === 'pending'` and needs to compose a MODE.ENABLE
 * UserOp. The route layer pre-checks the `BROKER_CALLBACK_SERVICE_SECRET`
 * shared-secret gate; this use-case adds the ownership re-check
 * (sessionId belongs to userId) at the repository layer for
 * defense-in-depth.
 *
 * Returns `null` when:
 *   - session not found
 *   - session not owned by the supplied userId
 *
 * The route maps `null` → 404. Throws `MissingEncryptionKeyError`
 * when `OPTION_D_C2_ENCRYPTION_KEY` is unset — the route maps that
 * to 503 with a clear remediation message.
 *
 * **Why a separate use-case** (vs inlining at the route): symmetry
 * with the rest of the policy/scoped-session surface
 * (`GetActiveScopedSessionUseCase`, `MintScopedSessionUseCase`,
 * `RevokeScopedSessionUseCase` all carry their own use-cases), and a
 * future audit-on-read or rate-limiting concern would plug in here
 * rather than at the HTTP boundary.
 */
export interface GetScopedSessionInstallMaterialInput {
  sessionId: string;
  userId: string;
}

export class GetScopedSessionInstallMaterialUseCase {
  constructor(private readonly scopedRepo: IScopedSessionRepository) {}

  async execute(
    input: GetScopedSessionInstallMaterialInput,
  ): Promise<ScopedSessionInstallMaterial | null> {
    return this.scopedRepo.findInstallMaterialById(input.sessionId, input.userId);
  }
}
