/**
 * Static registry binding each tool descriptor to its zod schema and
 * handler. Keeping this in one file means a CI lint can audit the
 * mapping in a single read — no risk of a tool being declared in
 * `descriptions.ts` but accidentally not wired to a handler, or vice
 * versa.
 *
 * The registry exposes a filtered view (`registryForReadOnly`) consumed
 * by `src/server.ts` when `MUHAVEN_READ_ONLY=true`. The filter prunes
 * the `position.*` and `policy.*` groups; only `read.*` tools remain
 * advertised. Mirrors `github/github-mcp-server`'s `--read-only` flag.
 */

import type { z } from 'zod';
import { TOOL_DESCRIPTORS, type ToolDescriptor } from './descriptions.js';
import {
  CashWrapInputSchema,
  PolicyAuditExportInputSchema,
  PolicyPauseInputSchema,
  PolicySessionKeyStatusInputSchema,
  PolicySetTierInputSchema,
  PositionBuyInputSchema,
  PositionClaimInputSchema,
  PositionRebalanceInputSchema,
  PositionSellInputSchema,
  ReadAuditInputSchema,
  ReadDistributionInputSchema,
  ReadPortfolioInputSchema,
  ReadTokensInputSchema,
  ReadYieldsInputSchema,
  // Wave 4 P7 — issuer group
  IssuerDistributeYieldInputSchema,
  IssuerKycAddInputSchema,
  IssuerKycRemoveInputSchema,
  IssuerUnpauseTokenInputSchema,
  IssuerAuditQueryInputSchema,
  // Wave 4 P11 — governance / protection / KYC group
  ReadProtectionCoverageInputSchema,
  ReadKycAttestationInputSchema,
  GovernanceProposeInputSchema,
  GovernanceCastVoteInputSchema,
} from './schemas.js';
import {
  cashWrap,
  policyAuditExport,
  policyPause,
  policySessionKeyStatus,
  policySetTier,
  positionBuy,
  positionClaim,
  positionRebalance,
  positionSell,
  readAudit,
  readDistribution,
  readPortfolio,
  readTokens,
  readYields,
  // Wave 4 P7 — issuer group
  issuerDistributeYield,
  issuerKycAdd,
  issuerKycRemove,
  issuerUnpauseToken,
  issuerAuditQuery,
  // Wave 4 P11 — governance / protection / KYC group
  readProtectionCoverage,
  readKycAttestation,
  governancePropose,
  governanceCastVote,
  type ToolDeps,
  type ToolResult,
} from './handlers.js';

export interface ToolEntry<TInput = unknown, TOutput = unknown> {
  descriptor: ToolDescriptor;
  schema: z.ZodTypeAny;
  handler: (input: TInput, deps: ToolDeps) => Promise<ToolResult<TOutput>>;
}

const HANDLERS: Record<string, Pick<ToolEntry, 'schema' | 'handler'>> = {
  'muhaven.read.portfolio': {
    schema: ReadPortfolioInputSchema,
    handler: readPortfolio as ToolEntry['handler'],
  },
  'muhaven.read.yields': {
    schema: ReadYieldsInputSchema,
    handler: readYields as ToolEntry['handler'],
  },
  'muhaven.read.distribution': {
    schema: ReadDistributionInputSchema,
    handler: readDistribution as ToolEntry['handler'],
  },
  'muhaven.read.tokens': {
    schema: ReadTokensInputSchema,
    handler: readTokens as ToolEntry['handler'],
  },
  'muhaven.read.audit': {
    schema: ReadAuditInputSchema,
    handler: readAudit as ToolEntry['handler'],
  },
  'muhaven.position.buy': {
    schema: PositionBuyInputSchema,
    handler: positionBuy as ToolEntry['handler'],
  },
  'muhaven.position.sell': {
    schema: PositionSellInputSchema,
    handler: positionSell as ToolEntry['handler'],
  },
  'muhaven.position.claim': {
    schema: PositionClaimInputSchema,
    handler: positionClaim as ToolEntry['handler'],
  },
  'muhaven.position.rebalance': {
    schema: PositionRebalanceInputSchema,
    handler: positionRebalance as ToolEntry['handler'],
  },
  // ── Path C cash group (2026-05-18) ────────────────────────────────
  'muhaven.cash.wrap': {
    schema: CashWrapInputSchema,
    handler: cashWrap as ToolEntry['handler'],
  },
  'muhaven.policy.set_tier': {
    schema: PolicySetTierInputSchema,
    handler: policySetTier as ToolEntry['handler'],
  },
  'muhaven.policy.pause': {
    schema: PolicyPauseInputSchema,
    handler: policyPause as ToolEntry['handler'],
  },
  'muhaven.policy.audit_export': {
    schema: PolicyAuditExportInputSchema,
    handler: policyAuditExport as ToolEntry['handler'],
  },
  'muhaven.policy.session_key_status': {
    schema: PolicySessionKeyStatusInputSchema,
    handler: policySessionKeyStatus as ToolEntry['handler'],
  },
  // ── Wave 4 P7 — issuer group ────────────────────────────────────
  'muhaven.issuer.distribute_yield': {
    schema: IssuerDistributeYieldInputSchema,
    handler: issuerDistributeYield as ToolEntry['handler'],
  },
  'muhaven.issuer.kyc_add': {
    schema: IssuerKycAddInputSchema,
    handler: issuerKycAdd as ToolEntry['handler'],
  },
  'muhaven.issuer.kyc_remove': {
    schema: IssuerKycRemoveInputSchema,
    handler: issuerKycRemove as ToolEntry['handler'],
  },
  'muhaven.issuer.unpause_token': {
    schema: IssuerUnpauseTokenInputSchema,
    handler: issuerUnpauseToken as ToolEntry['handler'],
  },
  'muhaven.issuer.audit_query': {
    schema: IssuerAuditQueryInputSchema,
    handler: issuerAuditQuery as ToolEntry['handler'],
  },
  // ── Wave 4 P11 — governance / protection / KYC group ──────────────
  'muhaven.read.protection_coverage': {
    schema: ReadProtectionCoverageInputSchema,
    handler: readProtectionCoverage as ToolEntry['handler'],
  },
  'muhaven.read.kyc_attestation': {
    schema: ReadKycAttestationInputSchema,
    handler: readKycAttestation as ToolEntry['handler'],
  },
  'muhaven.governance.propose': {
    schema: GovernanceProposeInputSchema,
    handler: governancePropose as ToolEntry['handler'],
  },
  'muhaven.governance.cast_vote': {
    schema: GovernanceCastVoteInputSchema,
    handler: governanceCastVote as ToolEntry['handler'],
  },
};

// Build the registry once at module load and assert every descriptor
// has a wired handler — fail fast at import time on drift.
const fullRegistry: ToolEntry[] = TOOL_DESCRIPTORS.map((descriptor) => {
  const entry = HANDLERS[descriptor.name];
  if (!entry) {
    throw new Error(`Tool descriptor "${descriptor.name}" has no handler wired in registry.ts`);
  }
  return { descriptor, schema: entry.schema, handler: entry.handler };
});

const wiredNames = new Set(fullRegistry.map((e) => e.descriptor.name));
for (const name of Object.keys(HANDLERS)) {
  if (!wiredNames.has(name)) {
    throw new Error(`Handler "${name}" has no descriptor in TOOL_DESCRIPTORS`);
  }
}

export function fullToolRegistry(): readonly ToolEntry[] {
  return fullRegistry;
}

export function registryForReadOnly(): readonly ToolEntry[] {
  return fullRegistry.filter((e) => e.descriptor.group === 'read');
}

export function selectRegistry(readOnly: boolean): readonly ToolEntry[] {
  return readOnly ? registryForReadOnly() : fullRegistry;
}
