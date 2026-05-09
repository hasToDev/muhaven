import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import {
  ChatLlmService,
  summarizeStubToolResult,
  __resetGeminiCacheForTests,
} from '../chat-llm.service.js';
import type { Surface } from '../../../domain/agent/model/surface.enum.js';
import type { Tier } from '../../../domain/agent/model/tier.enum.js';
import type { StreamEvent } from '../../../application/dto/agent/chat-stream.dto.js';

/**
 * Wave 4 P2 — `ChatLlmService` regression suite.
 *
 * These tests pin the agentic round-trip we shipped so the user-visible
 * "agent ran a tool but said nothing" failure mode (caught during the
 * `AGENTIC_TEST_PLAN.md` HavenBot smoke) doesn't recur. The Gemini path
 * is exercised against a hand-rolled mock SDK module installed via
 * `vi.mock('@google/genai', …)` so the suite stays hermetic.
 */

interface MockGeminiChunk {
  text?: string;
  functionCalls?: Array<{ name: string; args: Record<string, unknown> }>;
}

// Hoist mock state above `vi.mock` factories. `vi.mock` is hoisted to
// the top of the file by vitest, so any closure-captured `let` would be
// in the temporal-dead-zone on first read. `vi.hoisted` keeps the state
// initialiser co-located with the mocks.
const mockState = vi.hoisted(() => ({
  turns: [] as MockGeminiChunk[][],
  geminiKey: undefined as string | undefined,
  generateContentStreamSpy: vi.fn(),
}));

vi.mock('@google/genai', () => {
  class GoogleGenAI {
    public readonly models = {
      generateContentStream: mockState.generateContentStreamSpy,
    };
    constructor(_cfg: { apiKey: string }) {
      void _cfg;
    }
  }
  return { GoogleGenAI };
});

vi.mock('../../../core/config.js', () => ({
  getEnv: () => ({
    GEMINI_API_KEY: mockState.geminiKey,
    GEMINI_MODEL: 'gemini-2.0-flash',
    LOG_LEVEL: 'silent',
  }),
}));

const generateContentStreamSpy = mockState.generateContentStreamSpy;

beforeEach(() => {
  mockState.turns = [];
  __resetGeminiCacheForTests();
  generateContentStreamSpy.mockReset();
  generateContentStreamSpy.mockImplementation(async () => {
    const turn = mockState.turns.shift() ?? [];
    return (async function* () {
      for (const chunk of turn) {
        yield chunk;
      }
    })();
  });
});

afterEach(() => {
  __resetGeminiCacheForTests();
});

function collectingSink(): { events: StreamEvent[]; sink: (e: StreamEvent) => void } {
  const events: StreamEvent[] = [];
  return { events, sink: (e) => events.push(e) };
}

function streamText(events: StreamEvent[]): string {
  return events
    .filter((e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text')
    .map((e) => e.delta)
    .join('');
}

describe('summarizeStubToolResult', () => {
  it('describes an empty portfolio plainly', () => {
    const out = summarizeStubToolResult('muhaven_portfolio_summary', {
      tool: 'muhaven_portfolio_summary',
      walletAddress: '0xabc',
      positions: [],
      signals: { isOverexposed: null, isUnderYield: null, note: '' },
      totalPositions: 0,
    });
    expect(out).toMatch(/no rwa positions/i);
    expect(out).toMatch(/cash page/i);
  });

  it('lists symbols + signal note when positions are non-empty', () => {
    const out = summarizeStubToolResult('muhaven_portfolio_summary', {
      tool: 'muhaven_portfolio_summary',
      positions: [
        { tokenSymbol: 'TBILL1' },
        { tokenSymbol: 'GOLD1' },
      ],
      signals: { note: 'Wave 4 heuristic.' },
      totalPositions: 2,
    });
    expect(out).toContain('2 positions');
    expect(out).toContain('TBILL1');
    expect(out).toContain('GOLD1');
    expect(out).toContain('Wave 4 heuristic');
  });

  it('formats a quote with NAV + share estimate', () => {
    const out = summarizeStubToolResult('muhaven_quote', {
      tokenSymbol: 'TBILL1',
      navUsd6: '1000000',
      estimatedShares: '100',
    });
    expect(out).toContain('$1.0000');
    expect(out).toContain('100');
    expect(out).toContain('TBILL1');
  });

  it('returns null for propose_* tools (ConfirmModal is the surface)', () => {
    expect(summarizeStubToolResult('muhaven_propose_buy', { kind: 'buy' })).toBeNull();
    expect(summarizeStubToolResult('muhaven_propose_claim', { kind: 'claim' })).toBeNull();
    expect(summarizeStubToolResult('muhaven_pause', { kind: 'pause' })).toBeNull();
    expect(summarizeStubToolResult('muhaven_propose_kyc_add', { kind: 'kyc_add' })).toBeNull();
  });

  it('handles audit_query with totalCount', () => {
    const single = summarizeStubToolResult('muhaven_audit_query', { totalCount: 1 });
    expect(single).toContain('1 entry');
    const many = summarizeStubToolResult('muhaven_audit_query', { totalCount: 12 });
    expect(many).toContain('12 entries');
  });

  it('returns null for unknown tools (defensive)', () => {
    // Cast to bypass the union — defending against future tool additions
    // that forget to add a synthesizer branch.
    expect(summarizeStubToolResult('muhaven_unknown' as never, {})).toBeNull();
  });
});

describe('ChatLlmService.runStubLoop', () => {
  beforeEach(() => {
    mockState.geminiKey = undefined;
  });

  it('streams a deterministic synthesis + context-aware suggestions after a successful portfolio dispatch', async () => {
    const service = new ChatLlmService();
    const { events, sink } = collectingSink();
    await service.streamChat(
      {
        userId: 'u_1',
        walletAddress: '0xabc',
        surface: 'havenbot' as Surface,
        currentTier: 'advisory' as Tier,
        message: 'Show my portfolio.',
        history: [],
        dispatchTool: async () => ({
          tool: 'muhaven_portfolio_summary',
          walletAddress: '0xabc',
          positions: [],
          signals: { note: '' },
          totalPositions: 0,
        }),
      },
      sink,
    );

    const types = events.map((e) => e.type);
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types).toContain('suggestions');
    // Empty portfolio → wrap path.
    const sugg = events.find(
      (e): e is Extract<StreamEvent, { type: 'suggestions' }> => e.type === 'suggestions',
    );
    expect(sugg?.items.some((i) => /wrap/i.test(i.label))).toBe(true);
    expect(types[types.length - 1]).toBe('done');

    const text = streamText(events);
    expect(text).toMatch(/Pulling your encrypted portfolio summary/);
    expect(text).toMatch(/no rwa positions/i);
  });

  it('appends a failure note when the dispatched tool throws', async () => {
    const service = new ChatLlmService();
    const { events, sink } = collectingSink();
    await service.streamChat(
      {
        userId: 'u_1',
        walletAddress: '0xabc',
        surface: 'havenbot' as Surface,
        currentTier: 'advisory' as Tier,
        message: 'pause the agent',
        history: [],
        dispatchTool: async () => {
          throw new Error('policy gate refused');
        },
      },
      sink,
    );

    const failingResult = events.find(
      (e): e is Extract<StreamEvent, { type: 'tool_result' }> =>
        e.type === 'tool_result' && e.toolName === 'muhaven_pause',
    );
    expect(failingResult?.ok).toBe(false);
    expect(streamText(events)).toMatch(/policy gate refused/);
  });
});

describe('ChatLlmService.runGeminiLoop', () => {
  beforeEach(() => {
    mockState.geminiKey = 'test-key';
  });

  it('runs a second turn with functionResponse so the user sees the synthesis', async () => {
    mockState.turns = [
      // Turn 1 — model emits a function call (no text).
      [
        {
          functionCalls: [
            { name: 'muhaven_portfolio_summary', args: {} },
          ],
        },
      ],
      // Turn 2 — model synthesises the result-aware reply.
      [{ text: 'You currently hold no positions yet.' }],
    ];

    const service = new ChatLlmService();
    const { events, sink } = collectingSink();
    const dispatchSpy = vi.fn(async () => ({
      tool: 'muhaven_portfolio_summary',
      positions: [],
      totalPositions: 0,
      signals: { note: '' },
    }));

    await service.streamChat(
      {
        userId: 'u_1',
        walletAddress: '0xabc',
        surface: 'havenbot' as Surface,
        currentTier: 'advisory' as Tier,
        message: 'Show my portfolio.',
        history: [],
        dispatchTool: dispatchSpy,
      },
      sink,
    );

    expect(generateContentStreamSpy).toHaveBeenCalledTimes(2);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(streamText(events)).toMatch(/no positions/i);

    // The second-turn `contents` payload must include the function
    // response (model -> user with functionResponse) for the LLM to
    // synthesise correctly. Pin the wire shape.
    const secondCall = generateContentStreamSpy.mock.calls[1][0] as {
      contents: Array<{ role: string; parts: unknown[] }>;
    };
    const lastPart = secondCall.contents[secondCall.contents.length - 1];
    expect(lastPart.role).toBe('user');
    expect(lastPart.parts).toEqual([
      expect.objectContaining({
        functionResponse: expect.objectContaining({
          name: 'muhaven_portfolio_summary',
        }),
      }),
    ]);
  });

  it('caps tool round-trips at MAX_TOOL_TURNS (3) and emits an action-budget tail', async () => {
    // Three turns, each emits another function call — runaway scenario.
    mockState.turns = [
      [{ functionCalls: [{ name: 'muhaven_portfolio_summary', args: {} }] }],
      [{ functionCalls: [{ name: 'muhaven_portfolio_summary', args: {} }] }],
      [{ functionCalls: [{ name: 'muhaven_portfolio_summary', args: {} }] }],
    ];

    const service = new ChatLlmService();
    const { events, sink } = collectingSink();
    await service.streamChat(
      {
        userId: 'u_1',
        walletAddress: '0xabc',
        surface: 'havenbot' as Surface,
        currentTier: 'advisory' as Tier,
        message: 'Pull portfolio repeatedly',
        history: [],
        dispatchTool: async () => ({ totalPositions: 0, positions: [], signals: { note: '' } }),
      },
      sink,
    );

    // 3 dispatches max — bounded.
    const dispatchedCount = events.filter((e) => e.type === 'tool_call').length;
    expect(dispatchedCount).toBe(3);
    expect(streamText(events)).toMatch(/action budget/i);
  });

  it('strips confirmTokenId + sdkCall from ActionDescriptor before re-feeding to the model', async () => {
    mockState.turns = [
      [{ functionCalls: [{ name: 'muhaven_propose_buy', args: { tokenAddress: '0x' + 'aa'.repeat(20), shares: '100' } }] }],
      [{ text: 'Authorize when ready.' }],
    ];

    const service = new ChatLlmService();
    const { sink } = collectingSink();
    await service.streamChat(
      {
        userId: 'u_1',
        walletAddress: '0xabc',
        surface: 'havenbot' as Surface,
        currentTier: 'confirm-per-action' as Tier,
        message: 'Buy 100 of the gold token.',
        history: [],
        dispatchTool: async () => ({
          kind: 'buy',
          toolCallId: 'tcl_1',
          confirmTokenId: 'CT_PRIVATE_TOKEN',
          expiresAtSec: 1700000000,
          summary: 'Buy 100 GOLD1',
          preview: { tokenSymbol: 'GOLD1', shares: '100', navUsd6: '1000000' },
          sdkCall: {
            contractName: 'Subscription',
            functionName: 'purchase',
            args: { token: '0x' + 'aa'.repeat(20), shares: '100' },
          },
        }),
      },
      sink,
    );

    // Inspect the second-turn contents — confirm token + sdkCall must NOT
    // appear in the functionResponse. The summary + preview should pass.
    const secondCall = generateContentStreamSpy.mock.calls[1][0] as {
      contents: Array<{ role: string; parts: unknown[] }>;
    };
    const lastPart = secondCall.contents[secondCall.contents.length - 1];
    const fr = lastPart.parts[0] as { functionResponse: { response: Record<string, unknown> } };
    expect(fr.functionResponse.response).not.toHaveProperty('confirmTokenId');
    expect(fr.functionResponse.response).not.toHaveProperty('sdkCall');
    expect(fr.functionResponse.response).toHaveProperty('preview');
    expect(fr.functionResponse.response).toHaveProperty('kind', 'buy');
  });

  it('feeds a structured error back when dispatch throws so the model can apologise', async () => {
    mockState.turns = [
      [{ functionCalls: [{ name: 'muhaven_portfolio_summary', args: {} }] }],
      [{ text: 'Sorry — could not fetch portfolio.' }],
    ];

    const service = new ChatLlmService();
    const { events, sink } = collectingSink();
    await service.streamChat(
      {
        userId: 'u_1',
        walletAddress: '0xabc',
        surface: 'havenbot' as Surface,
        currentTier: 'advisory' as Tier,
        message: 'Show portfolio',
        history: [],
        dispatchTool: async () => {
          throw new Error('repo offline');
        },
      },
      sink,
    );

    expect(generateContentStreamSpy).toHaveBeenCalledTimes(2);
    const failed = events.find(
      (e): e is Extract<StreamEvent, { type: 'tool_result' }> => e.type === 'tool_result',
    );
    expect(failed?.ok).toBe(false);
    expect(streamText(events)).toMatch(/Sorry/);

    // Error must be wrapped in functionResponse, not omitted (so the
    // model can recover gracefully on the synthesis turn).
    const secondCall = generateContentStreamSpy.mock.calls[1][0] as {
      contents: Array<{ role: string; parts: unknown[] }>;
    };
    const lastPart = secondCall.contents[secondCall.contents.length - 1];
    const fr = lastPart.parts[0] as { functionResponse: { response: Record<string, unknown> } };
    expect(fr.functionResponse.response).toHaveProperty('error', 'repo offline');
  });

  it('injects the tokenCatalog into the systemInstruction so symbols can resolve to addresses', async () => {
    mockState.turns = [
      [{ text: 'TBILL1 is at 0xaaaa…aaaa.' }],
    ];

    const service = new ChatLlmService();
    const { sink } = collectingSink();
    await service.streamChat(
      {
        userId: 'u_1',
        walletAddress: '0xabc',
        surface: 'havenbot' as Surface,
        currentTier: 'advisory' as Tier,
        message: 'Quote 100 mhUSDC of TBILL1',
        history: [],
        tokenCatalog: [
          { symbol: 'TBILL1', address: '0x' + 'aa'.repeat(20), assetClass: 'treasury', status: 'active' },
          { symbol: 'GOLD1', address: '0x' + 'bb'.repeat(20), assetClass: 'other', status: 'paused' },
        ],
        dispatchTool: async () => ({}),
      },
      sink,
    );

    const callArg = generateContentStreamSpy.mock.calls[0][0] as {
      config: { systemInstruction: string };
    };
    expect(callArg.config.systemInstruction).toContain('KNOWN TOKENS');
    expect(callArg.config.systemInstruction).toContain('TBILL1: 0x' + 'aa'.repeat(20));
    expect(callArg.config.systemInstruction).toContain('GOLD1: 0x' + 'bb'.repeat(20));
    expect(callArg.config.systemInstruction).toContain('(treasury)');
    // Paused status surfaces in [brackets] so the LLM can warn the user
    // that the token is not currently quotable / buyable.
    expect(callArg.config.systemInstruction).toContain('[paused]');
  });

  it('omits the KNOWN TOKENS section when no catalog is supplied', async () => {
    mockState.turns = [
      [{ text: 'OK.' }],
    ];

    const service = new ChatLlmService();
    const { sink } = collectingSink();
    await service.streamChat(
      {
        userId: 'u_1',
        walletAddress: '0xabc',
        surface: 'havenbot' as Surface,
        currentTier: 'advisory' as Tier,
        message: 'hi',
        history: [],
        dispatchTool: async () => ({}),
      },
      sink,
    );

    const callArg = generateContentStreamSpy.mock.calls[0][0] as {
      config: { systemInstruction: string };
    };
    expect(callArg.config.systemInstruction).not.toContain('KNOWN TOKENS');
  });

  it('returns single-turn when the model emits text only (no tool calls)', async () => {
    mockState.turns = [
      [{ text: 'Here are the read tools you can ask me about.' }],
    ];

    const service = new ChatLlmService();
    const { events, sink } = collectingSink();
    await service.streamChat(
      {
        userId: 'u_1',
        walletAddress: '0xabc',
        surface: 'havenbot' as Surface,
        currentTier: 'advisory' as Tier,
        message: 'What can you do?',
        history: [],
        dispatchTool: async () => {
          throw new Error('should not be called');
        },
      },
      sink,
    );

    expect(generateContentStreamSpy).toHaveBeenCalledTimes(1);
    expect(streamText(events)).toContain('read tools');
  });

  it('falls back to the stub when Gemini throws on the first call', async () => {
    generateContentStreamSpy.mockImplementationOnce(async () => {
      throw new Error('upstream 500');
    });

    const service = new ChatLlmService();
    const { events, sink } = collectingSink();
    await service.streamChat(
      {
        userId: 'u_1',
        walletAddress: '0xabc',
        surface: 'havenbot' as Surface,
        currentTier: 'advisory' as Tier,
        message: 'show my portfolio',
        history: [],
        dispatchTool: async () => ({ totalPositions: 0, positions: [], signals: { note: '' } }),
      },
      sink,
    );

    // The error is surfaced + the stub takes over; the user sees a
    // result-aware sentence regardless.
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(streamText(events)).toMatch(/no rwa positions/i);
  });
});
