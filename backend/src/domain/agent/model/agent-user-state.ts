import type { Tier } from './tier.enum.js';
import type { Surface } from './surface.enum.js';
import type { Trigger } from './trigger.enum.js';

/**
 * One row per `(userId, surface)`. Per ADR-0 a user can hold different
 * tiers across surfaces, but cascading triggers (T-5, T-6) update every
 * surface row in lockstep.
 *
 * `confirmedActionCount` and `riskQuestionnaireComplete` are the two gates
 * that the state machine inspects when validating a
 * `ConfirmPerAction → PolicyBound` transition. `validatorAddress` records
 * the kernel-installed `@zerodev/permissions` validator currently in scope;
 * it's null in `Advisory` and `ConfirmPerAction` because no session key is
 * minted at those tiers.
 */
export interface AgentUserStateProps {
  userId: string;
  surface: Surface;
  tier: Tier;
  pausedAt: Date | null;
  pauseTrigger: Trigger | null;
  pauseMetadata: Record<string, unknown> | null;
  enteredAt: Date;
  validatorAddress: string | null;
  confirmedActionCount: number;
  riskQuestionnaireComplete: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export class AgentUserState {
  readonly userId: string;
  readonly surface: Surface;
  readonly tier: Tier;
  readonly pausedAt: Date | null;
  readonly pauseTrigger: Trigger | null;
  readonly pauseMetadata: Record<string, unknown> | null;
  readonly enteredAt: Date;
  readonly validatorAddress: string | null;
  readonly confirmedActionCount: number;
  readonly riskQuestionnaireComplete: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;

  constructor(props: AgentUserStateProps) {
    this.userId = props.userId;
    this.surface = props.surface;
    this.tier = props.tier;
    this.pausedAt = props.pausedAt;
    this.pauseTrigger = props.pauseTrigger;
    this.pauseMetadata = props.pauseMetadata;
    this.enteredAt = props.enteredAt;
    this.validatorAddress = props.validatorAddress;
    this.confirmedActionCount = props.confirmedActionCount;
    this.riskQuestionnaireComplete = props.riskQuestionnaireComplete;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  with(patch: Partial<AgentUserStateProps>): AgentUserState {
    return new AgentUserState({ ...this, ...patch, updatedAt: patch.updatedAt ?? new Date() });
  }
}
