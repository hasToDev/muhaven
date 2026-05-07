import { describe, expect, it, vi } from 'vitest';
import { ToolDispatcher, type ToolDispatcherDeps } from '../tool-dispatcher.js';
import { Surface } from '../../../domain/agent/model/surface.enum.js';
import { ApplicationHttpError } from '../../../core/errors.js';

/**
 * Wave 4 P2/P7 — `ToolDispatcher` is the deterministic action layer at
 * the planner→action boundary (per the CaMeL gate).
 *
 * The `tool-use-cases.test.ts` and `p7-issuer-tools.test.ts` suites
 * exercise the dispatcher transitively. This file isolates the
 * dispatcher itself: routing, gate invocation, recursive output
 * sanitisation, unknown-tool rejection, prototype-pollution rejection.
 *
 * Use-cases are stubbed so the dispatcher is the only thing under test.
 */

function noopUseCase<T = unknown>(toolMarker: string) {
  return {
    execute: vi.fn(async (..._args: unknown[]): Promise<T> => {
      return { tool: toolMarker } as T;
    }),
  };
}

function buildDeps(): ToolDispatcherDeps {
  // Use-cases are typed loosely; the dispatcher only calls `.execute`,
  // so a stub that records args + returns a marker payload is enough.
  // Casts to `unknown as ...` bypass the strict use-case signatures.
  return {
    portfolioSummary: noopUseCase('muhaven_portfolio_summary') as unknown as ToolDispatcherDeps['portfolioSummary'],
    quote: noopUseCase('muhaven_quote') as unknown as ToolDispatcherDeps['quote'],
    proposeBuy: noopUseCase('muhaven_propose_buy') as unknown as ToolDispatcherDeps['proposeBuy'],
    proposeClaim: noopUseCase('muhaven_propose_claim') as unknown as ToolDispatcherDeps['proposeClaim'],
    proposeRebalance: noopUseCase('muhaven_propose_rebalance') as unknown as ToolDispatcherDeps['proposeRebalance'],
    setPolicy: noopUseCase('muhaven_set_policy') as unknown as ToolDispatcherDeps['setPolicy'],
    pauseTool: noopUseCase('muhaven_pause') as unknown as ToolDispatcherDeps['pauseTool'],
    unsealPosition: noopUseCase('muhaven_unseal_position') as unknown as ToolDispatcherDeps['unsealPosition'],
    proposeDistributeYield: noopUseCase('muhaven_propose_distribute_yield') as unknown as ToolDispatcherDeps['proposeDistributeYield'],
    proposeKycAdd: noopUseCase('muhaven_propose_kyc_add') as unknown as ToolDispatcherDeps['proposeKycAdd'],
    proposeKycRemove: noopUseCase('muhaven_propose_kyc_remove') as unknown as ToolDispatcherDeps['proposeKycRemove'],
    proposeUnpauseToken: noopUseCase('muhaven_propose_unpause_token') as unknown as ToolDispatcherDeps['proposeUnpauseToken'],
    auditQuery: noopUseCase('muhaven_audit_query') as unknown as ToolDispatcherDeps['auditQuery'],
    // Wave 4 P11
    checkProtectionCoverage: noopUseCase('muhaven_check_protection_coverage') as unknown as ToolDispatcherDeps['checkProtectionCoverage'],
    explainKycAttestation: noopUseCase('muhaven_explain_kyc_attestation') as unknown as ToolDispatcherDeps['explainKycAttestation'],
    proposeGovernanceVote: noopUseCase('muhaven_propose_governance_vote') as unknown as ToolDispatcherDeps['proposeGovernanceVote'],
    castEncryptedVote: noopUseCase('muhaven_cast_encrypted_vote') as unknown as ToolDispatcherDeps['castEncryptedVote'],
  };
}

const CTX = {
  userId: 'u_test',
  walletAddress: '0x' + 'aa'.repeat(20),
  surface: Surface.HavenBot,
};

const VALID_TOKEN = '0x' + 'aa'.repeat(20);
const VALID_INVESTOR = '0x' + 'bb'.repeat(20);
const VALID_HANDLE = '0x' + 'a'.repeat(64);

describe('ToolDispatcher routing', () => {
  it('routes muhaven_portfolio_summary with empty args', async () => {
    const deps = buildDeps();
    const d = new ToolDispatcher(deps);
    const out = (await d.dispatch(CTX, 'muhaven_portfolio_summary', {})) as {
      tool: string;
    };
    expect(out.tool).toBe('muhaven_portfolio_summary');
    expect((deps.portfolioSummary.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('routes muhaven_quote with parsed args', async () => {
    const deps = buildDeps();
    const d = new ToolDispatcher(deps);
    await d.dispatch(CTX, 'muhaven_quote', {
      tokenAddress: VALID_TOKEN,
      notionalUsd6: '1000000',
    });
    const calls = (deps.quote.execute as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0]?.[0]).toEqual({
      tokenAddress: VALID_TOKEN,
      notionalUsd6: '1000000',
    });
  });

  it('routes muhaven_propose_buy through with the dispatcher context', async () => {
    const deps = buildDeps();
    const d = new ToolDispatcher(deps);
    await d.dispatch(CTX, 'muhaven_propose_buy', {
      tokenAddress: VALID_TOKEN,
      shares: '100',
    });
    const calls = (deps.proposeBuy.execute as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0]?.[0]).toEqual({
      userId: 'u_test',
      walletAddress: VALID_TOKEN === VALID_TOKEN ? '0x' + 'aa'.repeat(20) : VALID_TOKEN,
      surface: Surface.HavenBot,
    });
  });

  it('routes muhaven_propose_claim', async () => {
    const deps = buildDeps();
    const d = new ToolDispatcher(deps);
    await d.dispatch(CTX, 'muhaven_propose_claim', {
      yieldRecordId: '00000000-0000-0000-0000-000000000001',
    });
    expect((deps.proposeClaim.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('routes muhaven_propose_rebalance with leg array', async () => {
    const deps = buildDeps();
    const d = new ToolDispatcher(deps);
    await d.dispatch(CTX, 'muhaven_propose_rebalance', {
      legs: [
        { kind: 'sell', tokenAddress: VALID_TOKEN, shares: '50' },
        { kind: 'buy', tokenAddress: VALID_TOKEN, shares: '40' },
      ],
    });
    expect((deps.proposeRebalance.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('routes muhaven_set_policy', async () => {
    const deps = buildDeps();
    const d = new ToolDispatcher(deps);
    await d.dispatch(CTX, 'muhaven_set_policy', {
      surface: 'havenbot',
      targetTier: 'confirm-per-action',
    });
    expect((deps.setPolicy.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('routes muhaven_pause with optional surface', async () => {
    const deps = buildDeps();
    const d = new ToolDispatcher(deps);
    await d.dispatch(CTX, 'muhaven_pause', {});
    expect((deps.pauseTool.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('routes muhaven_unseal_position with handle + signerHint default', async () => {
    const deps = buildDeps();
    const d = new ToolDispatcher(deps);
    await d.dispatch(CTX, 'muhaven_unseal_position', {
      handle: VALID_HANDLE,
    });
    const calls = (deps.unsealPosition.execute as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
    // Zod default fills in signerHint='session'.
    expect(calls[0]?.[0]).toEqual({ handle: VALID_HANDLE, signerHint: 'session' });
  });

  it('routes muhaven_propose_distribute_yield (P7)', async () => {
    const deps = buildDeps();
    const d = new ToolDispatcher(deps);
    await d.dispatch(CTX, 'muhaven_propose_distribute_yield', {
      tokenAddress: VALID_TOKEN,
      totalYieldUsd6: '1000000',
    });
    expect((deps.proposeDistributeYield.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('routes muhaven_propose_kyc_add (P7)', async () => {
    const deps = buildDeps();
    const d = new ToolDispatcher(deps);
    await d.dispatch(CTX, 'muhaven_propose_kyc_add', {
      tokenAddress: VALID_TOKEN,
      investorAddress: VALID_INVESTOR,
      kycTier: 1,
    });
    expect((deps.proposeKycAdd.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('routes muhaven_propose_kyc_remove (P7)', async () => {
    const deps = buildDeps();
    const d = new ToolDispatcher(deps);
    await d.dispatch(CTX, 'muhaven_propose_kyc_remove', {
      tokenAddress: VALID_TOKEN,
      investorAddress: VALID_INVESTOR,
    });
    expect((deps.proposeKycRemove.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('routes muhaven_propose_unpause_token (P7)', async () => {
    const deps = buildDeps();
    const d = new ToolDispatcher(deps);
    await d.dispatch(CTX, 'muhaven_propose_unpause_token', {
      tokenAddress: VALID_TOKEN,
      initialNavUsd6: '1000000',
    });
    expect((deps.proposeUnpauseToken.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('routes muhaven_audit_query (P7)', async () => {
    const deps = buildDeps();
    const d = new ToolDispatcher(deps);
    await d.dispatch(CTX, 'muhaven_audit_query', {});
    expect((deps.auditQuery.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  // ── Wave 4 P11 — governance / protection / KYC tools ────────────
  it('routes muhaven_check_protection_coverage (P11)', async () => {
    const deps = buildDeps();
    const d = new ToolDispatcher(deps);
    await d.dispatch(CTX, 'muhaven_check_protection_coverage', {
      tokenAddress: VALID_TOKEN,
    });
    expect(
      (deps.checkProtectionCoverage.execute as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(1);
  });

  it('routes muhaven_explain_kyc_attestation (P11) with empty args', async () => {
    const deps = buildDeps();
    const d = new ToolDispatcher(deps);
    await d.dispatch(CTX, 'muhaven_explain_kyc_attestation', {});
    const calls = (deps.explainKycAttestation.execute as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
    // First arg is callerWallet from CTX.
    expect(calls[0]?.[0]).toBe(CTX.walletAddress);
  });

  it('routes muhaven_propose_governance_vote (P11)', async () => {
    const deps = buildDeps();
    const d = new ToolDispatcher(deps);
    await d.dispatch(CTX, 'muhaven_propose_governance_vote', {
      tokenAddress: VALID_TOKEN,
      proposalType: 0,
    });
    expect(
      (deps.proposeGovernanceVote.execute as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(1);
  });

  it('routes muhaven_cast_encrypted_vote (P11)', async () => {
    const deps = buildDeps();
    const d = new ToolDispatcher(deps);
    await d.dispatch(CTX, 'muhaven_cast_encrypted_vote', {
      proposalId: '1',
      voteYes: true,
    });
    expect(
      (deps.castEncryptedVote.execute as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(1);
  });
});

describe('ToolDispatcher — CaMeL gate enforcement', () => {
  it('rejects an unknown tool name with badRequest (camel gate)', async () => {
    const deps = buildDeps();
    const d = new ToolDispatcher(deps);
    await expect(d.dispatch(CTX, 'muhaven_drop_database', {})).rejects.toBeInstanceOf(
      ApplicationHttpError,
    );
    // No use-case fires.
    for (const u of Object.values(deps)) {
      expect((u.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    }
  });

  it('rejects prototype-pollution shapes (gate runs first)', async () => {
    const deps = buildDeps();
    const d = new ToolDispatcher(deps);
    // The CaMeL gate refuses args that contain dangerous keys at the
    // top level. Constructed via assign so the parser doesn't reject
    // the literal at parse time.
    const malicious = Object.assign({}, { tokenAddress: VALID_TOKEN, shares: '100' }) as Record<
      string,
      unknown
    >;
    Object.defineProperty(malicious, '__proto__', {
      value: { polluted: true },
      enumerable: true,
    });
    await expect(d.dispatch(CTX, 'muhaven_propose_buy', malicious)).rejects.toBeInstanceOf(
      ApplicationHttpError,
    );
    expect((deps.proposeBuy.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('rejects a scalar arg (gate refuses non-object args)', async () => {
    const deps = buildDeps();
    const d = new ToolDispatcher(deps);
    await expect(d.dispatch(CTX, 'muhaven_quote', 42)).rejects.toBeInstanceOf(
      ApplicationHttpError,
    );
    await expect(d.dispatch(CTX, 'muhaven_quote', 'string')).rejects.toBeInstanceOf(
      ApplicationHttpError,
    );
  });

  it('rejects an array arg (gate refuses arrays at the top level)', async () => {
    const deps = buildDeps();
    const d = new ToolDispatcher(deps);
    await expect(d.dispatch(CTX, 'muhaven_quote', [1, 2, 3])).rejects.toBeInstanceOf(
      ApplicationHttpError,
    );
  });
});

describe('ToolDispatcher — output sanitiser', () => {
  it('strips ANSI escapes from string fields in tool result', async () => {
    const ESC = String.fromCharCode(0x1b);
    const deps = buildDeps();
    // Override the portfolioSummary stub to return a polluted string.
    deps.portfolioSummary = {
      execute: vi
        .fn()
        .mockResolvedValue({
          tool: 'muhaven_portfolio_summary',
          // Bell character + ANSI red sequence + plain text.
          someField: `${ESC}[31mDANGER${ESC}[0m`,
          nested: { also: `${ESC}[1m‎hidden${ESC}[0m` },
        }) as unknown as ToolDispatcherDeps['portfolioSummary']['execute'],
    } as ToolDispatcherDeps['portfolioSummary'];
    const d = new ToolDispatcher(deps);
    const out = (await d.dispatch(CTX, 'muhaven_portfolio_summary', {})) as {
      someField: string;
      nested: { also: string };
    };
    // Sanitiser removes ESC bytes and the ANSI sequences.
    expect(out.someField).not.toMatch(//);
    expect(out.nested.also).not.toMatch(//);
    // Plain content survives.
    expect(out.someField).toContain('DANGER');
  });

  it('passes through non-string values verbatim', async () => {
    const deps = buildDeps();
    deps.portfolioSummary = {
      execute: vi.fn().mockResolvedValue({
        tool: 'muhaven_portfolio_summary',
        positions: [],
        totalPositions: 0,
        signals: { isOverexposed: null, isUnderYield: false, note: 'plain' },
      }) as unknown as ToolDispatcherDeps['portfolioSummary']['execute'],
    } as ToolDispatcherDeps['portfolioSummary'];
    const d = new ToolDispatcher(deps);
    const out = (await d.dispatch(CTX, 'muhaven_portfolio_summary', {})) as {
      totalPositions: number;
      signals: { isOverexposed: null; isUnderYield: boolean; note: string };
    };
    expect(out.totalPositions).toBe(0);
    expect(out.signals.isUnderYield).toBe(false);
    expect(out.signals.note).toBe('plain');
  });
});

describe('ToolDispatcher — Zod re-validation defense', () => {
  it('rejects propose_buy with a non-hex token (Zod refuses regex)', async () => {
    const deps = buildDeps();
    const d = new ToolDispatcher(deps);
    await expect(
      d.dispatch(CTX, 'muhaven_propose_buy', {
        tokenAddress: 'not-an-address',
        shares: '100',
      }),
    ).rejects.toBeDefined();
    expect((deps.proposeBuy.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('rejects propose_buy with an invalid shares string', async () => {
    const deps = buildDeps();
    const d = new ToolDispatcher(deps);
    await expect(
      d.dispatch(CTX, 'muhaven_propose_buy', {
        tokenAddress: VALID_TOKEN,
        shares: '0', // regex ^[1-9]\d*$ requires positive
      }),
    ).rejects.toBeDefined();
  });

  it('rejects rebalance with too many legs', async () => {
    const deps = buildDeps();
    const d = new ToolDispatcher(deps);
    const tooMany = Array.from({ length: 9 }, (_, i) => ({
      kind: 'buy' as const,
      tokenAddress: VALID_TOKEN,
      shares: String(i + 1),
    }));
    await expect(
      d.dispatch(CTX, 'muhaven_propose_rebalance', { legs: tooMany }),
    ).rejects.toBeDefined();
  });

  it('rejects audit_query with malformed since (must be ISO datetime)', async () => {
    const deps = buildDeps();
    const d = new ToolDispatcher(deps);
    await expect(
      d.dispatch(CTX, 'muhaven_audit_query', { since: 'yesterday' }),
    ).rejects.toBeDefined();
  });
});
