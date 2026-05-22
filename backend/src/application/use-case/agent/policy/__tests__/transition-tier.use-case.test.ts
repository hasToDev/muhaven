import { describe, it, expect, beforeEach } from 'vitest';
import { AgentUserState } from '../../../../../domain/agent/model/agent-user-state.js';
import { AuditEventType } from '../../../../../domain/agent/model/audit-event-type.enum.js';
import { Surface } from '../../../../../domain/agent/model/surface.enum.js';
import { Tier } from '../../../../../domain/agent/model/tier.enum.js';
import { MemoryAgentAuditRepository } from '../../../../../infrastructure/repository/memory/memory-agent-audit.repository.js';
import { MemoryAgentConfirmTokenRepository } from '../../../../../infrastructure/repository/memory/index.js';
import { MemoryAgentStateRepository } from '../../../../../infrastructure/repository/memory/memory-agent-state.repository.js';
import { AppendAuditEventUseCase } from '../append-audit-event.use-case.js';
import { ConfirmTokenService } from '../confirm-token.service.js';
import { GetPolicyStateUseCase } from '../get-policy-state.use-case.js';
import { CommitTierTransitionUseCase, RequestTierTransitionUseCase } from '../transition-tier.use-case.js';

/**
 * Compliance Auditor R2 H-1 (Wave 5 Path D Slice 2 Commit 2.B): the
 * forensic chain `userop → ScopedSessionMinted → TierChanged →
 * ConfirmTokenConsumed → ConfirmTokenIssued` MUST be reconstructable
 * from `agent_audit_events` alone (WORM) without joining against the
 * mutable `agent_confirm_tokens` table. PATH_D_PLAN.md §"Slice 2
 * audit-correlation requirement" (line 263-265, Security M-2)
 * mandates `actionHash` on every Scoped-bound `TierChanged` and the
 * matching `ConfirmTokenConsumed`.
 *
 * Pre-Commit-2.B-fix: `ConfirmTokenConsumed` carried only
 * `{actionKind, targetTier}`; `TierChanged` carried no metadata. The
 * forensic chain {mint → consume} required a join against the mutable
 * tokens table. This test pins the fix: both audit rows now carry
 * `actionHash`, joinable against the mint row's `consentActionHash`.
 */

const NOW = new Date('2026-05-22T12:00:00.000Z');

describe('CommitTierTransitionUseCase — forensic-chain actionHash anchoring', () => {
  let stateRepo: MemoryAgentStateRepository;
  let auditRepo: MemoryAgentAuditRepository;
  let tokenRepo: MemoryAgentConfirmTokenRepository;
  let confirmTokens: ConfirmTokenService;
  let appendAudit: AppendAuditEventUseCase;
  let getPolicyState: GetPolicyStateUseCase;
  let issueUseCase: RequestTierTransitionUseCase;
  let commitUseCase: CommitTierTransitionUseCase;

  beforeEach(() => {
    stateRepo = new MemoryAgentStateRepository();
    auditRepo = new MemoryAgentAuditRepository();
    tokenRepo = new MemoryAgentConfirmTokenRepository();
    confirmTokens = new ConfirmTokenService(tokenRepo);
    appendAudit = new AppendAuditEventUseCase(auditRepo);
    getPolicyState = new GetPolicyStateUseCase(stateRepo);
    issueUseCase = new RequestTierTransitionUseCase(
      stateRepo,
      getPolicyState,
      confirmTokens,
      appendAudit,
    );
    commitUseCase = new CommitTierTransitionUseCase(
      stateRepo,
      getPolicyState,
      confirmTokens,
      appendAudit,
    );
  });

  async function seed(tier: Tier, confirmedActionCount = 5): Promise<void> {
    await stateRepo.upsert(
      new AgentUserState({
        userId: 'u1',
        surface: Surface.MCP,
        tier,
        pausedAt: null,
        pauseTrigger: null,
        pauseMetadata: null,
        enteredAt: NOW,
        validatorAddress: null,
        confirmedActionCount,
        riskQuestionnaireComplete: true,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
  }

  it('embeds the SAME 0x-prefixed actionHash on ConfirmTokenIssued + ConfirmTokenConsumed + TierChanged (Security M-2 forensic chain)', async () => {
    await seed(Tier.ConfirmPerAction);

    // Phase 1 — issue. Step-up to PolicyBound requires a confirmation
    // token. The issue path emits ConfirmTokenIssued with actionHash.
    const issued = await issueUseCase.execute({
      userId: 'u1',
      surface: Surface.MCP,
      targetTier: Tier.PolicyBound,
      now: NOW,
    });
    if (!issued.requiresConfirmation) {
      throw new Error('test setup: expected requiresConfirmation=true');
    }

    // `ConfirmTokenService.hashAction` returns bare-hex (no `0x`
    // prefix) — the DB column `agent_confirm_tokens.action_hash`
    // historical shape. The audit-metadata view normalizes to
    // `0x`-prefixed so the chain JOIN against the mint row's
    // `consentActionHash` (Zod-enforced `0x`-prefixed) matches
    // byte-for-byte. Test pins the normalization invariant — without
    // it, a regression that drops `toChainAnchorHash` would silently
    // re-introduce the chain-break bug.
    const bareHashHex = issued.confirmation.actionHash;
    expect(bareHashHex).toMatch(/^[0-9a-f]{64}$/);
    const expectedAnchorHash = `0x${bareHashHex}`;

    // Phase 2 — commit. Consumes the token + upserts the new tier.
    await commitUseCase.execute({
      userId: 'u1',
      surface: Surface.MCP,
      targetTier: Tier.PolicyBound,
      confirmationToken: issued.confirmation.token,
      now: NOW,
    });

    const page = await auditRepo.findByUserId('u1');
    // Sort defensively; in-memory repo already sorts by (createdAt, id)
    // ascending, but the exact ordering between rows sharing a NOW
    // timestamp would be implementation-detail. Filter by eventType
    // instead.
    const findByType = (t: AuditEventType): Record<string, unknown> => {
      const row = page.items.find((e) => e.eventType === t);
      if (!row) throw new Error(`expected ${t} audit row, not found`);
      if (!row.metadata) throw new Error(`expected ${t} metadata to be non-null`);
      return row.metadata;
    };

    // ConfirmTokenIssued carries `0x`-prefixed actionHash. (Pre-2.B
    // this emission existed but stored the bare-hex form; the
    // normalization landed in 2.B so ALL chain anchors share shape.)
    const issuedMeta = findByType(AuditEventType.ConfirmTokenIssued);
    expect(issuedMeta.actionHash).toBe(expectedAnchorHash);

    // ConfirmTokenConsumed gains actionHash in Commit 2.B (H-1 fix).
    const consumedMeta = findByType(AuditEventType.ConfirmTokenConsumed);
    expect(consumedMeta.actionHash).toBe(expectedAnchorHash);
    expect(consumedMeta.actionKind).toBe('tier_transition');

    // TierChanged gains actionHash in Commit 2.B (H-1 fix). The audit
    // row's tierBefore/tierAfter remain unchanged.
    const tierChangedRow = page.items.find(
      (e) => e.eventType === AuditEventType.TierChanged,
    );
    expect(tierChangedRow).toBeDefined();
    expect(tierChangedRow?.tierBefore).toBe(Tier.ConfirmPerAction);
    expect(tierChangedRow?.tierAfter).toBe(Tier.PolicyBound);
    expect(tierChangedRow?.metadata?.actionHash).toBe(expectedAnchorHash);

    // Strict shape assertion: every chain anchor MUST be 0x-prefixed
    // 64-hex so the forensic-chain JOIN against
    // `ScopedSessionMinted.metadata.consentActionHash` (Zod
    // `HEX_32_BYTE_RE`) finds matches. Without this assertion, a
    // future regression that drops `toChainAnchorHash` at one emit
    // site would silently break the JOIN.
    const ANCHOR_SHAPE = /^0x[0-9a-f]{64}$/;
    expect(issuedMeta.actionHash).toMatch(ANCHOR_SHAPE);
    expect(consumedMeta.actionHash).toMatch(ANCHOR_SHAPE);
    expect(tierChangedRow?.metadata?.actionHash).toMatch(ANCHOR_SHAPE);
  });
});
