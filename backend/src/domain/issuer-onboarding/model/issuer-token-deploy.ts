/**
 * Phase 9.A · Expansion (F2) — issuer-token-deploy domain model.
 *
 * One row per `POST /v1/issuer/tokens/deploy` invocation. The HTTP layer
 * inserts with `status='running'`, the deploy library writes step
 * transitions through the progress callback (mutating `lastStep`), and
 * the final outcome lands as `succeeded` (with `resultTokenAddress`) or
 * `failed` (with `errorMessage` + `lastStep`).
 *
 * Steps ordered to mirror `scripts/onboard-token.ts` so the wizard's
 * deploy rail can render the contract surface 1:1.
 */
export type DeployStatus = 'running' | 'succeeded' | 'failed';

export type DeployStepKey =
  | 'deploy_token'
  | 'deploy_queue'
  | 'deploy_treasury'
  | 'wire_token_pointers'
  | 'authorize_investor_registry'
  | 'authorize_compliance_callers'
  | 'configure_oracle'
  | 'register_token';

export const DEPLOY_STEPS: readonly DeployStepKey[] = [
  'deploy_token',
  'deploy_queue',
  'deploy_treasury',
  'wire_token_pointers',
  'authorize_investor_registry',
  'authorize_compliance_callers',
  'configure_oracle',
  'register_token',
] as const;

export interface DeployConfig {
  symbol: string;
  name: string;
  asset_class: 'treasury' | 'money_market' | 'private_credit' | 'real_estate' | 'other';
  initial_nav: string;
  min_investment: string;
  yield_schedule: 'monthly' | 'quarterly' | 'annual';
  applicant_address: string;
}

export interface IssuerTokenDeployParams {
  id: string;
  userId: string;
  symbol: string;
  config: DeployConfig;
  status: DeployStatus;
  lastStep: DeployStepKey | null;
  resultTokenAddress: string | null;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export class IssuerTokenDeploy {
  readonly id: string;
  readonly userId: string;
  readonly symbol: string;
  readonly config: DeployConfig;
  readonly status: DeployStatus;
  readonly lastStep: DeployStepKey | null;
  readonly resultTokenAddress: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;

  constructor(params: IssuerTokenDeployParams) {
    this.id = params.id;
    this.userId = params.userId;
    this.symbol = params.symbol;
    this.config = params.config;
    this.status = params.status;
    this.lastStep = params.lastStep;
    this.resultTokenAddress = params.resultTokenAddress;
    this.errorMessage = params.errorMessage;
    this.createdAt = params.createdAt;
    this.completedAt = params.completedAt;
  }
}
