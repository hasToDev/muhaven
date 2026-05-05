/**
 * Singleton row tracking the policy-engine cron's last tick. Persisted so
 * the engine can recover monotonic state across restarts and so audit
 * queries can show "engine alive" status.
 *
 * The single allowed primary key is `'policy-engine'`. Other cron
 * lifecycles (NAV writer, tax-event indexer) keep their own separate
 * persistence — this row is the policy-engine alone.
 */
export const POLICY_ENGINE_CRON_ID = 'policy-engine';

export interface AgentCronStateProps {
  id: string;
  lastTickAt: Date | null;
  lastTickUserCount: number | null;
  lastTickBreachCount: number | null;
  lastTickError: string | null;
  updatedAt: Date;
}

export class AgentCronState {
  readonly id: string;
  readonly lastTickAt: Date | null;
  readonly lastTickUserCount: number | null;
  readonly lastTickBreachCount: number | null;
  readonly lastTickError: string | null;
  readonly updatedAt: Date;

  constructor(props: AgentCronStateProps) {
    this.id = props.id;
    this.lastTickAt = props.lastTickAt;
    this.lastTickUserCount = props.lastTickUserCount;
    this.lastTickBreachCount = props.lastTickBreachCount;
    this.lastTickError = props.lastTickError;
    this.updatedAt = props.updatedAt;
  }
}
