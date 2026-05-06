import { randomUUID } from 'crypto';
import { Surface, SURFACE_VALUES } from '../../../../domain/agent/model/surface.enum.js';
import { Trigger } from '../../../../domain/agent/model/trigger.enum.js';
import type { PauseAgentUseCase } from '../policy/pause-agent.use-case.js';
import type {
  PauseToolDto,
  PauseActionDescriptor,
} from '../../../dto/agent/tool.dto.js';

export interface PauseToolContext {
  userId: string;
  /** Surface from which the LLM emitted the tool call. */
  emittingSurface: Surface;
}

/**
 * Wave 4 P2 — `muhaven_pause` (idempotent kill-switch — T-1 in ADR-0).
 *
 * Unlike the other propose tools, `muhaven_pause` is auditable on its own —
 * a confirm token is unnecessary because pausing is the safest possible
 * default and re-pausing is idempotent. The tool calls `PauseAgentUseCase`
 * directly and returns a descriptor for UX feedback ("Paused — your agent
 * has stopped").
 *
 * If `dto.surface` is omitted the call cascades across all surfaces (T-1
 * panic mode, mirrors `/api/v1/agent/policy/pause` without `surface`).
 */
export class PauseToolUseCase {
  constructor(private readonly pauseAgent: PauseAgentUseCase) {}

  async execute(
    ctx: PauseToolContext,
    input: PauseToolDto,
    now: Date = new Date(),
  ): Promise<PauseActionDescriptor> {
    const targetSurfaces: Surface[] = input.surface ? [input.surface] : [...SURFACE_VALUES];

    let cascade = false;
    for (const surface of targetSurfaces) {
      const result = await this.pauseAgent.execute({
        userId: ctx.userId,
        surface,
        trigger: Trigger.ExplicitPause,
        metadata: {
          tool: 'muhaven_pause',
          emittingSurface: ctx.emittingSurface,
        },
        now,
      });
      cascade = cascade || result.cascade;
    }

    const toolCallId = `tc_${randomUUID()}`;
    return {
      kind: 'pause',
      toolCallId,
      // Pause is auditable without a confirm token — the audit-commit POST
      // is a no-op for this tool. We still mint a token id (UUID) so the
      // frontend can correlate the receipt; consume returns an idempotent
      // 200 because the audit row already landed.
      confirmTokenId: `pause_${toolCallId}`,
      expiresAtSec: Math.floor(now.getTime() / 1000) + 300,
      summary: input.surface
        ? `Paused ${input.surface}. Resume from /agent or by calling muhaven_set_policy.`
        : `Paused all 4 surfaces. Resume each from /agent or by calling muhaven_set_policy.`,
      preview: {
        surface: input.surface ?? null,
        cascade,
        note: 'Pause is the safest possible default — your agent has stopped submitting transactions on every paused surface.',
      },
      sdkCall: {
        contractName: 'MuHavenAgentPolicy',
        functionName: 'pause',
        args: input.surface ? { surface: input.surface } : {},
      },
    };
  }
}
