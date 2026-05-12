import { ApplicationHttpError } from '../../core/errors.js';
import { Surface } from '../../domain/agent/model/surface.enum.js';
import {
  PortfolioSummaryDtoSchema,
  QuoteDtoSchema,
  ProposeBuyDtoSchema,
  ProposeClaimDtoSchema,
  ProposeRebalanceDtoSchema,
  SetPolicyDtoSchema,
  PauseToolDtoSchema,
  UnsealPositionDtoSchema,
} from '../../application/dto/agent/tool.dto.js';
import {
  ProposeDistributeYieldDtoSchema,
  ProposeKycAddDtoSchema,
  ProposeKycRemoveDtoSchema,
  ProposeUnpauseTokenDtoSchema,
  AuditQueryToolDtoSchema,
  ProposeCreateCheckoutDtoSchema,
} from '../../application/dto/agent/issuer-tool.dto.js';
import {
  CheckProtectionCoverageDtoSchema,
  ExplainKycAttestationDtoSchema,
  ProposeGovernanceVoteDtoSchema,
  CastEncryptedVoteDtoSchema,
} from '../../application/dto/agent/p11-tool.dto.js';
import type {
  PortfolioSummaryToolUseCase,
  QuoteToolUseCase,
  ProposeBuyToolUseCase,
  ProposeClaimToolUseCase,
  ProposeRebalanceToolUseCase,
  SetPolicyToolUseCase,
  PauseToolUseCase,
  UnsealPositionToolUseCase,
  ProposeDistributeYieldToolUseCase,
  ProposeKycAddToolUseCase,
  ProposeKycRemoveToolUseCase,
  ProposeUnpauseTokenToolUseCase,
  AuditQueryToolUseCase,
  ProposeCreateCheckoutToolUseCase,
  CheckProtectionCoverageToolUseCase,
  ExplainKycAttestationToolUseCase,
  ProposeGovernanceVoteToolUseCase,
  CastEncryptedVoteToolUseCase,
} from '../../application/use-case/agent/tool/index.js';
import { gatePlannerIntent, sanitiseToolResult } from './safety/index.js';

export interface ToolDispatcherDeps {
  portfolioSummary: PortfolioSummaryToolUseCase;
  quote: QuoteToolUseCase;
  proposeBuy: ProposeBuyToolUseCase;
  proposeClaim: ProposeClaimToolUseCase;
  proposeRebalance: ProposeRebalanceToolUseCase;
  setPolicy: SetPolicyToolUseCase;
  pauseTool: PauseToolUseCase;
  unsealPosition: UnsealPositionToolUseCase;
  // Wave 4 P7 — issuer-side tools
  proposeDistributeYield: ProposeDistributeYieldToolUseCase;
  proposeKycAdd: ProposeKycAddToolUseCase;
  proposeKycRemove: ProposeKycRemoveToolUseCase;
  proposeUnpauseToken: ProposeUnpauseTokenToolUseCase;
  auditQuery: AuditQueryToolUseCase;
  proposeCreateCheckout: ProposeCreateCheckoutToolUseCase;
  // Wave 4 P11 — governance / protection / KYC tools
  checkProtectionCoverage: CheckProtectionCoverageToolUseCase;
  explainKycAttestation: ExplainKycAttestationToolUseCase;
  proposeGovernanceVote: ProposeGovernanceVoteToolUseCase;
  castEncryptedVote: CastEncryptedVoteToolUseCase;
}

export interface ToolDispatcherContext {
  userId: string;
  walletAddress: string;
  surface: Surface;
}

/**
 * Wave 4 P2 — uniform tool dispatcher.
 *
 * One entry point used by the streaming chat route AND the per-tool REST
 * endpoints. Centralizes:
 * - Strict-enum validation via the shared DTO schemas (R-1 mitigation).
 * - Tier-gate routing (each propose use case re-checks; this is defense
 *   in depth — the route handler's `withAuth` already established userId).
 * - Surface tagging — the LLM is currently always on `havenbot`, but
 *   the same dispatcher serves MCP/OpenClaw/checkout in P3..P5.
 *
 * Returns the tool's structured response. Errors propagate as
 * ApplicationHttpError so route + SSE stream both surface them
 * uniformly to the client.
 */
export class ToolDispatcher {
  constructor(private readonly deps: ToolDispatcherDeps) {}

  async dispatch(
    ctx: ToolDispatcherContext,
    toolName: string,
    rawArgs: unknown,
  ): Promise<unknown> {
    // P8 — CaMeL gate: deterministic sanitisation between planner LLM
    // intent and the action layer. Reject prototype-pollution shapes,
    // strip ANSI/smuggling Unicode in args, and tag a correlation id.
    const gated = gatePlannerIntent({ toolName, rawArgs });
    const result = await this.dispatchInner(ctx, gated.toolName, gated.cleanArgs);
    // P8 — sanitise the tool result before it reaches the planner LLM
    // context or hits the SSE wire. Defence-in-depth on top of strict
    // Zod schemas — guards against an upstream contract / API returning
    // smuggled bytes that could rewrite chat history visually.
    return sanitiseToolResult(result);
  }

  private async dispatchInner(
    ctx: ToolDispatcherContext,
    toolName: string,
    rawArgs: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    switch (toolName) {
      case 'muhaven_portfolio_summary': {
        const args = PortfolioSummaryDtoSchema.parse(rawArgs ?? {});
        return this.deps.portfolioSummary.execute(ctx.userId, ctx.walletAddress, args);
      }
      case 'muhaven_quote': {
        const args = QuoteDtoSchema.parse(rawArgs);
        return this.deps.quote.execute(args);
      }
      case 'muhaven_propose_buy': {
        const args = ProposeBuyDtoSchema.parse(rawArgs);
        return this.deps.proposeBuy.execute(
          { userId: ctx.userId, walletAddress: ctx.walletAddress, surface: ctx.surface },
          args,
        );
      }
      case 'muhaven_propose_claim': {
        const args = ProposeClaimDtoSchema.parse(rawArgs);
        return this.deps.proposeClaim.execute(
          { userId: ctx.userId, surface: ctx.surface },
          args,
        );
      }
      case 'muhaven_propose_rebalance': {
        const args = ProposeRebalanceDtoSchema.parse(rawArgs);
        return this.deps.proposeRebalance.execute(
          { userId: ctx.userId, surface: ctx.surface },
          args,
        );
      }
      case 'muhaven_set_policy': {
        const args = SetPolicyDtoSchema.parse(rawArgs);
        return this.deps.setPolicy.execute(
          { userId: ctx.userId, emittingSurface: ctx.surface },
          args,
        );
      }
      case 'muhaven_pause': {
        const args = PauseToolDtoSchema.parse(rawArgs ?? {});
        return this.deps.pauseTool.execute(
          { userId: ctx.userId, emittingSurface: ctx.surface },
          args,
        );
      }
      case 'muhaven_unseal_position': {
        const args = UnsealPositionDtoSchema.parse(rawArgs);
        return this.deps.unsealPosition.execute(args);
      }
      // ── Wave 4 P7 — issuer-side tools ───────────────────────────────
      case 'muhaven_propose_distribute_yield': {
        const args = ProposeDistributeYieldDtoSchema.parse(rawArgs);
        return this.deps.proposeDistributeYield.execute(
          {
            userId: ctx.userId,
            walletAddress: ctx.walletAddress,
            surface: ctx.surface,
          },
          args,
        );
      }
      case 'muhaven_propose_kyc_add': {
        const args = ProposeKycAddDtoSchema.parse(rawArgs);
        return this.deps.proposeKycAdd.execute(
          {
            userId: ctx.userId,
            walletAddress: ctx.walletAddress,
            surface: ctx.surface,
          },
          args,
        );
      }
      case 'muhaven_propose_kyc_remove': {
        const args = ProposeKycRemoveDtoSchema.parse(rawArgs);
        return this.deps.proposeKycRemove.execute(
          {
            userId: ctx.userId,
            walletAddress: ctx.walletAddress,
            surface: ctx.surface,
          },
          args,
        );
      }
      case 'muhaven_propose_unpause_token': {
        const args = ProposeUnpauseTokenDtoSchema.parse(rawArgs);
        return this.deps.proposeUnpauseToken.execute(
          {
            userId: ctx.userId,
            walletAddress: ctx.walletAddress,
            surface: ctx.surface,
          },
          args,
        );
      }
      case 'muhaven_audit_query': {
        const args = AuditQueryToolDtoSchema.parse(rawArgs ?? {});
        return this.deps.auditQuery.execute({ userId: ctx.userId }, args);
      }
      case 'muhaven_propose_create_checkout': {
        const args = ProposeCreateCheckoutDtoSchema.parse(rawArgs);
        return this.deps.proposeCreateCheckout.execute(
          {
            userId: ctx.userId,
            walletAddress: ctx.walletAddress,
            surface: ctx.surface,
          },
          args,
        );
      }
      // ── Wave 4 P11 — governance / protection / KYC tools ───────────
      case 'muhaven_check_protection_coverage': {
        const args = CheckProtectionCoverageDtoSchema.parse(rawArgs);
        return this.deps.checkProtectionCoverage.execute(args);
      }
      case 'muhaven_explain_kyc_attestation': {
        const args = ExplainKycAttestationDtoSchema.parse(rawArgs ?? {});
        return this.deps.explainKycAttestation.execute(ctx.walletAddress, args);
      }
      case 'muhaven_propose_governance_vote': {
        const args = ProposeGovernanceVoteDtoSchema.parse(rawArgs);
        return this.deps.proposeGovernanceVote.execute(
          {
            userId: ctx.userId,
            walletAddress: ctx.walletAddress,
            surface: ctx.surface,
          },
          args,
        );
      }
      case 'muhaven_cast_encrypted_vote': {
        const args = CastEncryptedVoteDtoSchema.parse(rawArgs);
        return this.deps.castEncryptedVote.execute(
          {
            userId: ctx.userId,
            walletAddress: ctx.walletAddress,
            surface: ctx.surface,
          },
          args,
        );
      }
      default:
        throw ApplicationHttpError.badRequest(`Unknown tool: ${toolName}`);
    }
  }
}
