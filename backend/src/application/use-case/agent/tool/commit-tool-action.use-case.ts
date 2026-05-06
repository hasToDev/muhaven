import { Surface } from '../../../../domain/agent/model/surface.enum.js';
import { AuditEventType } from '../../../../domain/agent/model/audit-event-type.enum.js';
import { ApplicationHttpError } from '../../../../core/errors.js';
import type { ConfirmTokenService } from '../policy/confirm-token.service.js';
import type { AppendAuditEventUseCase } from '../policy/append-audit-event.use-case.js';
import type { IAgentStateRepository } from '../../../../domain/agent/repository/agent-state.repository.js';
import type {
  CommitToolActionDto,
  CommitToolActionResponseDto,
} from '../../../dto/agent/tool.dto.js';

/**
 * Wave 4 P2 — closes the propose → confirm → commit loop.
 *
 * Frontend posts after the on-chain tx confirms (or after `set_policy`
 * forwards through `/policy/transition`). The use case:
 * 1. Atomically consumes the confirm token (R-3 single-use).
 * 2. Appends a `permit_granted` + `confirm_token_consumed` audit pair.
 * 3. Bumps the surface's `confirmedActionCount` so the
 *    Confirm-per-action → PolicyBound gate can advance after ≥5 confirms.
 *
 * Pause-tool tokens (`pause_tc_*`) are accepted as a no-op success — the
 * pause already wrote its audit row at proposal time. We keep the route
 * signature uniform so frontends don't need a "did this tool need a
 * commit?" branch.
 */
export class CommitToolActionUseCase {
  constructor(
    private readonly confirmTokens: ConfirmTokenService,
    private readonly appendAudit: AppendAuditEventUseCase,
    private readonly stateRepo: IAgentStateRepository,
  ) {}

  async execute(
    userId: string,
    surface: Surface,
    actionPayload: Record<string, unknown>,
    actionKind: 'permit_grant' | 'tier_transition',
    input: CommitToolActionDto,
    now: Date = new Date(),
  ): Promise<CommitToolActionResponseDto> {
    // Pause-tool fast path — no consume needed (idempotent at proposal).
    if (input.confirmToken.startsWith('pause_tc_')) {
      const audit = await this.appendAudit.execute({
        userId,
        surface,
        eventType: AuditEventType.ConfirmTokenConsumed,
        now,
        metadata: {
          tool: 'muhaven_pause',
          txHash: input.txHash,
          ...(input.metadata ?? {}),
        },
      });
      return { consumed: true, auditEventId: audit.id };
    }

    // The frontend echoes back the action payload it received from the
    // ActionDescriptor (so the action-hash matches). The ConfirmTokenService
    // does the conditional consume + replay rejection.
    await this.confirmTokens.consume(input.confirmToken, userId, actionKind, actionPayload, now);

    const audit = await this.appendAudit.execute({
      userId,
      surface,
      eventType: AuditEventType.PermitGranted,
      now,
      metadata: {
        actionKind,
        txHash: input.txHash,
        ...(input.metadata ?? {}),
      },
    });
    await this.appendAudit.execute({
      userId,
      surface,
      eventType: AuditEventType.ConfirmTokenConsumed,
      now,
      metadata: { confirmTokenId: input.confirmToken },
    });

    // Bump the confirmed action count so Confirm-per-action gate works.
    // Read-modify-write — we tolerate a benign race where two parallel
    // commits each see the same starting count; production-volume Wave 4
    // does not depend on monotonic counts for the gate (the threshold is
    // ≥5, off-by-one is fine). Wave 5 hardens via SQL-side increment.
    const state = await this.stateRepo.findByUserAndSurface(userId, surface);
    if (state) {
      // Only bump for permit_grant — tier_transition follows /policy/transition
      // which counts the gate separately.
      if (actionKind === 'permit_grant') {
        const next = state.with({
          confirmedActionCount: state.confirmedActionCount + 1,
          updatedAt: now,
        });
        await this.stateRepo.upsert(next);
      }
    }

    return { consumed: true, auditEventId: audit.id };
  }
}
