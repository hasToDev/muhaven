import { randomUUID } from 'node:crypto';
import type { Address } from 'viem';
import { ApplicationHttpError } from '../../../core/errors.js';
import { getLogger } from '../../../core/logger.js';
import type { IUserRepository } from '../../../domain/auth/repository/user.repository.js';
import type { IIssuerTokenDeployRepository } from '../../../domain/issuer-onboarding/repository/issuer-token-deploy.repository.js';
import type { IRwaTokenRepository } from '../../../domain/token-registry/repository/rwa-token.repository.js';
import {
  IssuerTokenDeploy,
  type DeployConfig,
} from '../../../domain/issuer-onboarding/model/issuer-token-deploy.js';
import { RwaToken } from '../../../domain/token-registry/model/rwa-token.js';
import type {
  DeployTokenLibrary,
  DeployProgressEvent,
} from '../../../infrastructure/onboarding/deploy-token.library.js';
import { deployEventBus } from '../../../infrastructure/onboarding/deploy-event-bus.js';
import type { DeployTokenDto, DeployTokenAcceptedDto } from '../../dto/issuer/deploy-token.dto.js';

/**
 * Phase 9.A · Expansion (F2) — kicks off the issuer-onboarding deploy
 * flow.
 *
 * `start()` returns immediately with a `deploy_id` (HTTP 202). The
 * actual deploy runs in-process via `void this.run(...)` — the SSE
 * endpoint subscribes to `deployEventBus` to stream progress, and the
 * `issuer_token_deploys` row is the durable fallback if the SSE
 * channel drops.
 *
 * Invariants:
 *   - Caller must be `role='issuer'` AND `issuer_status='approved'`.
 *     Enforced by `withRole('issuer')` middleware + this use case's
 *     guard against unapproved status (defense-in-depth).
 *   - Symbol pre-checked against `tokenRegistry.getRegisteredTokens` —
 *     409 SYMBOL_TAKEN before any tx is signed.
 *   - On failure mid-deploy: row finalises to `failed` with the last
 *     successful step + the error message; SSE emits a terminal
 *     `finalize/failed` event.
 *   - Partial-deploy artifacts (orphan token proxy etc.) are accepted
 *     ops debt; documented in `DEFERRED_FEATURES.md`.
 */
export class DeployTokenUseCase {
  private readonly logger = getLogger('DeployTokenUseCase');

  constructor(
    private readonly userRepo: IUserRepository,
    private readonly deployRepo: IIssuerTokenDeployRepository,
    private readonly library: DeployTokenLibrary,
    private readonly rwaTokenRepo: IRwaTokenRepository,
  ) {}

  async start(userId: string, dto: DeployTokenDto): Promise<DeployTokenAcceptedDto> {
    const user = await this.userRepo.findById(userId);
    if (!user) {
      throw ApplicationHttpError.unauthorized('User not found');
    }
    if (user.role !== 'issuer' || user.issuerStatus !== 'approved') {
      throw ApplicationHttpError.forbidden(
        'Issuer onboarding required before token deploy',
        { code: 'NOT_APPROVED_ISSUER' },
      );
    }

    // Symbol pre-check. The lib re-checks at deploy time too (race), but
    // the early check gives the wizard a clean 409 instead of a deep
    // mid-deploy failure.
    const existing = await this.library.findExistingTokenBySymbol(dto.symbol);
    if (existing) {
      throw ApplicationHttpError.conflict(
        `Symbol ${dto.symbol} is already registered`,
        { code: 'SYMBOL_TAKEN', existingTokenAddress: existing },
      );
    }

    const config: DeployConfig = {
      symbol: dto.symbol,
      name: dto.name,
      asset_class: dto.asset_class,
      initial_nav: dto.initial_nav,
      min_investment: dto.min_investment,
      yield_schedule: dto.yield_schedule,
      applicant_address: user.walletAddress,
    };

    const deploy = new IssuerTokenDeploy({
      id: randomUUID(),
      userId: user.id,
      symbol: dto.symbol,
      config,
      status: 'running',
      lastStep: null,
      resultTokenAddress: null,
      errorMessage: null,
      createdAt: new Date(),
      completedAt: null,
    });
    await this.deployRepo.save(deploy);

    // Fire-and-forget. The SSE endpoint subscribes via deployEventBus.
    // We deliberately do NOT await — the HTTP response is 202 + deploy_id.
    void this.run(deploy.id, deploy.config, user.walletAddress as Address);

    return { deploy_id: deploy.id, status: 'running' };
  }

  private async run(
    deployId: string,
    config: DeployConfig,
    applicant: Address,
  ): Promise<void> {
    const onProgress = async (event: DeployProgressEvent): Promise<void> => {
      try {
        await this.deployRepo.updateProgress(deployId, event.step);
      } catch (err) {
        this.logger.warn({ err, deployId, event }, 'Failed to persist progress');
      }
      deployEventBus.publish(deployId, {
        step: event.step,
        status: event.status,
        txHash: event.txHash,
        contractAddress: event.contractAddress,
        ts: new Date().toISOString(),
      });
    };

    try {
      const result = await this.library.deploy(
        {
          symbol: config.symbol,
          name: config.name,
          applicant,
          initialNav: BigInt(config.initial_nav),
          minInvestment: BigInt(config.min_investment),
          // Issuer-controlled cap: 100 USDC (1e8 base units) — same default as
          // `onboard-token.ts:35`.
          instantRedeemCap: 100_000_000n,
          // Default 86400s = 1 day epochs (same as script default).
          epochDuration: 86_400,
        },
        onProgress,
      );

      // Insert the rwa_tokens row immediately so /tokens reflects the
      // just-deployed token without waiting for `pnpm seed:tokens:v35`
      // to backfill from on-chain. Mirrors the seed-demo-issuers
      // posture (same shape, same paused initial state — kernel /
      // operator unpauses post-setNAV via `unpause-token.ts`).
      //
      // Defensive against a race where the row already exists (e.g.
      // an operator ran `seed:tokens:v35` between `register_token`
      // mining and this write); a lookup-then-skip is enough since
      // the deploy can never produce two distinct rows for one
      // token. Failures here are logged but do NOT regress the
      // deploy's `succeeded` status — the on-chain work is committed
      // and the catch-up script remains a working fallback.
      try {
        const existing = await this.rwaTokenRepo.findByAddress(result.tokenAddress);
        if (!existing) {
          const now = new Date();
          await this.rwaTokenRepo.save(
            new RwaToken({
              id: randomUUID(),
              address: result.tokenAddress,
              name: config.name,
              symbol: config.symbol,
              issuerAddress: applicant,
              yieldSchedule: config.yield_schedule,
              kycTier: 0,
              assetClass: config.asset_class,
              minInvestment: config.min_investment,
              status: 'paused',
              // Wave 5+ per-token snapshot proxy (2026-05-23) — the
              // frontend's `getYieldSnapshot(token)` routes to this
              // address when registered, falling back to the env-var
              // singleton for legacy rows missing the column.
              yieldSnapshotAddress: result.yieldSnapshotAddress,
              createdAt: now,
              updatedAt: now,
              pausedAt: now,
            }),
          );
        }
      } catch (err) {
        this.logger.warn(
          { err, deployId, tokenAddress: result.tokenAddress },
          'Failed to write rwa_tokens row post-deploy — operator can recover via `pnpm seed:tokens:v35`',
        );
      }

      await this.deployRepo.finalize(deployId, {
        status: 'succeeded',
        resultTokenAddress: result.tokenAddress,
        lastStep: 'register_token',
      });
      deployEventBus.publish(deployId, {
        step: 'finalize',
        status: 'succeeded',
        resultTokenAddress: result.tokenAddress,
        ts: new Date().toISOString(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error({ err, deployId }, 'Deploy failed');
      await this.deployRepo.finalize(deployId, {
        status: 'failed',
        errorMessage: message.slice(0, 1000),
      });
      deployEventBus.publish(deployId, {
        step: 'finalize',
        status: 'failed',
        errorMessage: message.slice(0, 1000),
        ts: new Date().toISOString(),
      });
    } finally {
      // Hold the buffer for a beat so a slow SSE consumer can still drain
      // it before cleanup. 60s is a generous safety margin.
      setTimeout(() => deployEventBus.cleanup(deployId), 60_000).unref();
    }
  }
}
