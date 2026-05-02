import type { IssuerTokenDeploy, DeployStatus, DeployStepKey } from '../model/issuer-token-deploy.js';

export interface IIssuerTokenDeployRepository {
  save(deploy: IssuerTokenDeploy): Promise<void>;
  findById(id: string): Promise<IssuerTokenDeploy | null>;
  /**
   * Atomically mutates a job row's progress without re-saving the entire
   * domain object. Used by the deploy library's progress callback to
   * surface the most recent step before the job terminates.
   */
  updateProgress(id: string, lastStep: DeployStepKey): Promise<void>;
  /**
   * Atomically finalises a job. `completedAt` is set to now() so the
   * SSE-disconnect-then-poll fallback can detect job completion.
   */
  finalize(
    id: string,
    update: {
      status: Exclude<DeployStatus, 'running'>;
      resultTokenAddress?: string | null;
      errorMessage?: string | null;
      lastStep?: DeployStepKey | null;
    },
  ): Promise<void>;
}
