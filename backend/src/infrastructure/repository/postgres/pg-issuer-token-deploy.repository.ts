import { eq } from 'drizzle-orm';
import type { IIssuerTokenDeployRepository } from '../../../domain/issuer-onboarding/repository/issuer-token-deploy.repository.js';
import {
  IssuerTokenDeploy,
  type DeployConfig,
  type DeployStatus,
  type DeployStepKey,
} from '../../../domain/issuer-onboarding/model/issuer-token-deploy.js';
import { issuerTokenDeploys } from './schema.js';
import type { Db } from './db.js';

export class PgIssuerTokenDeployRepository implements IIssuerTokenDeployRepository {
  constructor(private readonly db: Db) {}

  async save(deploy: IssuerTokenDeploy): Promise<void> {
    await this.db
      .insert(issuerTokenDeploys)
      .values({
        id: deploy.id,
        userId: deploy.userId,
        symbol: deploy.symbol,
        config: deploy.config,
        status: deploy.status,
        lastStep: deploy.lastStep,
        resultTokenAddress: deploy.resultTokenAddress,
        errorMessage: deploy.errorMessage,
        createdAt: deploy.createdAt,
        completedAt: deploy.completedAt,
      })
      .onConflictDoUpdate({
        target: issuerTokenDeploys.id,
        set: {
          status: deploy.status,
          lastStep: deploy.lastStep,
          resultTokenAddress: deploy.resultTokenAddress,
          errorMessage: deploy.errorMessage,
          completedAt: deploy.completedAt,
        },
      });
  }

  async findById(id: string): Promise<IssuerTokenDeploy | null> {
    const row = await this.db.query.issuerTokenDeploys.findFirst({
      where: eq(issuerTokenDeploys.id, id),
    });
    return row ? this.toDomain(row) : null;
  }

  async updateProgress(id: string, lastStep: DeployStepKey): Promise<void> {
    await this.db
      .update(issuerTokenDeploys)
      .set({ lastStep })
      .where(eq(issuerTokenDeploys.id, id));
  }

  async finalize(
    id: string,
    update: {
      status: Exclude<DeployStatus, 'running'>;
      resultTokenAddress?: string | null;
      errorMessage?: string | null;
      lastStep?: DeployStepKey | null;
    },
  ): Promise<void> {
    const set: Record<string, unknown> = {
      status: update.status,
      completedAt: new Date(),
    };
    if (update.resultTokenAddress !== undefined) {
      set.resultTokenAddress = update.resultTokenAddress;
    }
    if (update.errorMessage !== undefined) {
      set.errorMessage = update.errorMessage;
    }
    if (update.lastStep !== undefined) {
      set.lastStep = update.lastStep;
    }
    await this.db.update(issuerTokenDeploys).set(set).where(eq(issuerTokenDeploys.id, id));
  }

  private toDomain(row: typeof issuerTokenDeploys.$inferSelect): IssuerTokenDeploy {
    return new IssuerTokenDeploy({
      id: row.id,
      userId: row.userId,
      symbol: row.symbol,
      config: row.config as DeployConfig,
      status: row.status as DeployStatus,
      lastStep: (row.lastStep as DeployStepKey | null) ?? null,
      resultTokenAddress: row.resultTokenAddress ?? null,
      errorMessage: row.errorMessage ?? null,
      createdAt: row.createdAt,
      completedAt: row.completedAt ?? null,
    });
  }
}
