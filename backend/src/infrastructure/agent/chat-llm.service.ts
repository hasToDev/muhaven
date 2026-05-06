import type { Surface } from '../../domain/agent/model/surface.enum.js';
import type { Tier } from '../../domain/agent/model/tier.enum.js';
import type { StreamEvent } from '../../application/dto/agent/chat-stream.dto.js';
import { getEnv } from '../../core/config.js';
import { getLogger } from '../../core/logger.js';
import {
  preprocessChatInput,
  buildArmorNudge,
  sanitiseToolResult,
  type PromptArmorResult,
  type Violation,
} from './safety/index.js';

const logger = getLogger('chat-llm');

/**
 * Wave 4 P2 — backend LLM service for HavenBot streaming chat.
 *
 * Uses Google's Gemini API (the user provided a Gemini key, not a Claude
 * one — see ADR-6). The wire shape stays Vercel-AI-SDK-compatible so a
 * Wave 5 swap to `@ai-sdk/anthropic` is a one-line provider change in
 * the streamText() call site.
 *
 * **No-key fallback**: when `GEMINI_API_KEY` is unset, the service runs
 * a deterministic intent classifier that emits the same StreamEvent
 * shape as the LLM path. This keeps the UI working in dev/CI without
 * a key, and makes test assertions reliable. Production prod uses the
 * real Gemini path.
 */

export type ChatHistoryMessage = { role: 'user' | 'agent'; text: string };

export interface ChatStreamRequest {
  userId: string;
  walletAddress: string;
  surface: Surface;
  currentTier: Tier;
  message: string;
  history: ChatHistoryMessage[];
  /** Tool dispatch callback. Returns the structured tool result that gets
   *  fed back into the next LLM turn. */
  dispatchTool: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
}

export interface IChatLlmService {
  streamChat(req: ChatStreamRequest, sink: (event: StreamEvent) => void): Promise<void>;
}

const TOOL_NAMES = [
  'muhaven_portfolio_summary',
  'muhaven_quote',
  'muhaven_propose_buy',
  'muhaven_propose_claim',
  'muhaven_propose_rebalance',
  'muhaven_set_policy',
  'muhaven_pause',
  'muhaven_unseal_position',
  // Wave 4 P7 — issuer-side tools (ADR-8). The planner sees the same
  // catalog regardless of caller role; the use-case-side issuer +
  // approved + token-issuer-of-record gates produce structured 403s
  // for non-issuers.
  'muhaven_propose_distribute_yield',
  'muhaven_propose_kyc_add',
  'muhaven_propose_kyc_remove',
  'muhaven_propose_unpause_token',
  'muhaven_audit_query',
] as const;

type ToolName = (typeof TOOL_NAMES)[number];

const SYSTEM_PROMPT = `You are HavenBot, a confidential RWA portfolio copilot for MuHaven.

YOUR ROLE
- You help investors operate MuHaven flows on Arbitrum Sepolia.
- You PROPOSE actions; you do not sign. Every write goes through the policy gate.
- You always use structured tool intents — never compose raw JSON-RPC.

YOUR CAPABILITIES (read tools — no policy gate)
- muhaven_portfolio_summary: Encrypted portfolio summary + signal flags.
- muhaven_quote(tokenAddress, notionalUsd6): NAV-derived buy quote.
- muhaven_unseal_position(handle): Client-driven decrypt instructions.

YOUR CAPABILITIES (write tools — tier-gated)
- muhaven_propose_buy(tokenAddress, shares): Atomic purchase via Subscription.
- muhaven_propose_claim(yieldRecordId): Pull yield from a finalized epoch.
- muhaven_propose_rebalance(legs[]): Multi-leg sell + buy.
- muhaven_set_policy(targetTier): Tier transition.
- muhaven_pause(): Kill-switch.

YOUR CAPABILITIES (issuer-only write tools — tier-gated, requires approved issuer kernel)
- muhaven_propose_distribute_yield(tokenAddress, totalYieldUsd6, label?): Schedule a yield epoch via SDK distributeYield.
- muhaven_propose_kyc_add(tokenAddress, investorAddress, kycTier): Add an investor to the KYC whitelist.
- muhaven_propose_kyc_remove(tokenAddress, investorAddress): Remove an investor from the KYC whitelist.
- muhaven_propose_unpause_token(tokenAddress, initialNavUsd6): Set initial NAV + unpause a freshly-deployed token.

YOUR CAPABILITIES (issuer-only read tools)
- muhaven_audit_query(surface?, eventTypes?, since?, until?, cursor?, limit?): Read your own tiered-autonomy audit log.

YOUR CONSTRAINTS
- NEVER bypass the policy gate. NEVER call signing endpoints directly.
- NEVER reveal another user's portfolio data — every encrypted handle requires a permit signed by the data owner.
- NEVER suggest actions outside the user's current tier; instead suggest raising the tier (muhaven_set_policy) which the user signs separately.
- You are NOT a financial advisor — you provide tools and information.
- All balances, amounts, and risk parameters are FHE-encrypted on-chain. You operate on encrypted state through tool surfaces; you never decrypt directly.

PRIVACY PRINCIPLE
Your strategy, the user's strategy, and the encrypted state itself are private. Nobody else — not competitors, not MEV bots, not operator infra, not the LLM provider, not even you — can see the portfolio without an explicit user-signed permit.`;

/**
 * Lazy-instantiate the Gemini client only when the key is set, so the
 * backend boots fine without it. We dynamic-import the SDK so cold-start
 * dev environments without `@google/genai` installed still work — the
 * stub fallback just kicks in.
 */
let _geminiClient: unknown = null;
let _geminiAttempted = false;

async function tryLoadGemini(): Promise<unknown | null> {
  if (_geminiAttempted) return _geminiClient;
  _geminiAttempted = true;
  const key = getEnv().GEMINI_API_KEY;
  if (!key) return null;
  try {
    // Dynamic import — `@google/genai` is an optional dependency and may
    // not be installed in dev/CI. The cast suppresses the type-level
    // module resolution; the runtime branch handles the missing-package
    // case via the catch block below.
    const mod = (await import(
      // @ts-ignore — optional peer dep; the import is guarded by env check above.
      '@google/genai' as string
    )) as {
      GoogleGenAI?: new (cfg: { apiKey: string }) => unknown;
    };
    if (!mod.GoogleGenAI) {
      logger.warn('@google/genai loaded but GoogleGenAI export not found — using stub fallback');
      return null;
    }
    _geminiClient = new mod.GoogleGenAI({ apiKey: key });
    return _geminiClient;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '@google/genai not installed — using stub fallback. Run `pnpm add @google/genai` in backend/ to enable real LLM.',
    );
    return null;
  }
}

/**
 * Stub fallback. Pure intent classifier — same surface as the LLM path
 * so the SSE wire shape stays identical for tests + dev iteration. The
 * classifier intentionally errs on the side of NOT emitting a tool
 * call when the message is ambiguous (better-to-ask than to-act).
 */
function stubIntentClassifier(message: string): {
  text: string;
  toolCall?: { toolName: ToolName; args: Record<string, unknown> };
} {
  const lower = message.toLowerCase();
  if (
    lower.includes('portfolio')
    || lower.includes('balance')
    || lower.includes('holding')
  ) {
    return {
      text: 'Pulling your encrypted portfolio summary now.',
      toolCall: { toolName: 'muhaven_portfolio_summary', args: {} },
    };
  }
  if (lower.includes('pause') || lower.includes('stop the agent') || lower.includes('kill switch')) {
    return {
      text: 'Pausing your agent across every surface. You can resume from this chat or the policy page.',
      toolCall: { toolName: 'muhaven_pause', args: {} },
    };
  }
  // Default: explanatory response with a recommendation.
  return {
    text:
      'I can help with portfolio summaries, NAV quotes, buys, claims, rebalances, '
      + 'policy tier changes, or pausing the agent. What would you like to do?',
  };
}

export class ChatLlmService implements IChatLlmService {
  async streamChat(
    req: ChatStreamRequest,
    sink: (event: StreamEvent) => void,
  ): Promise<void> {
    const sessionId = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // P8 — PromptArmor preprocessing. Sanitise the user message + every
    // history entry before either path (Gemini or stub) sees them. A
    // critical-tier violation hard-blocks; warn/info pass through with a
    // system-prompt nudge so the planner LLM treats the content as data.
    const armored = applyArmorPipeline(req);
    if (armored.blocked) {
      sink({ type: 'meta', model: 'armor-blocked', sessionId });
      logger.warn(
        {
          userId: req.userId,
          rules: armored.violations.map((v) => v.rule),
        },
        'PromptArmor blocked chat input',
      );
      sink({
        type: 'error',
        message:
          'Your message was rejected by the safety layer because it matched a known prompt-injection shape. '
          + 'Try rephrasing in plain language without code blocks, embedded instructions, or hidden formatting.',
      });
      sink({ type: 'done', finishReason: 'error' });
      return;
    }

    const gemini = await tryLoadGemini();

    if (!gemini) {
      sink({ type: 'meta', model: 'stub', sessionId });
      await this.runStubLoop({ ...req, message: armored.message, history: armored.history }, sink);
      sink({ type: 'done', finishReason: 'stop' });
      return;
    }

    sink({ type: 'meta', model: 'gemini-2.0-flash', sessionId });
    let geminiEmittedAny = false;
    const guardedSink = (event: StreamEvent): void => {
      if (
        event.type === 'text'
        || event.type === 'tool_call'
        || event.type === 'tool_result'
      ) {
        geminiEmittedAny = true;
      }
      sink(event);
    };
    const cleanReq: ChatStreamRequest = {
      ...req,
      message: armored.message,
      history: armored.history,
    };
    try {
      await this.runGeminiLoop(gemini, cleanReq, guardedSink, armored.nudge);
      sink({ type: 'done', finishReason: 'stop' });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Gemini stream error');
      sink({
        type: 'error',
        message:
          'The LLM call failed. ' + (geminiEmittedAny ? '' : 'The stub responder will take over for this turn — your data is safe.'),
      });
      // H3 fix: only run the stub if Gemini emitted nothing usable yet.
      // Otherwise we'd risk a duplicate ActionDescriptor when the LLM
      // had already pushed one (e.g., a propose_buy) before erroring.
      if (!geminiEmittedAny) {
        await this.runStubLoop(cleanReq, sink);
      }
      sink({ type: 'done', finishReason: 'stop' });
    }
  }

  private async runStubLoop(
    req: ChatStreamRequest,
    sink: (event: StreamEvent) => void,
  ): Promise<void> {
    const { text, toolCall } = stubIntentClassifier(req.message);

    // Fake-stream the text to keep the UX consistent with the LLM path.
    for (const chunk of chunkText(text)) {
      sink({ type: 'text', delta: chunk });
    }

    if (!toolCall) return;

    const toolCallId = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sink({ type: 'tool_call', toolCallId, toolName: toolCall.toolName, args: toolCall.args });
    try {
      const result = await req.dispatchTool(toolCall.toolName, toolCall.args);
      sink({
        type: 'tool_result',
        toolCallId,
        toolName: toolCall.toolName,
        ok: true,
        result: sanitiseToolResult(result),
      });
    } catch (err) {
      sink({
        type: 'tool_result',
        toolCallId,
        toolName: toolCall.toolName,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async runGeminiLoop(
    client: unknown,
    req: ChatStreamRequest,
    sink: (event: StreamEvent) => void,
    armorNudge?: string | null,
  ): Promise<void> {
    // Wave 4 P2 ships the Gemini integration as a thin wrapper around the
    // streaming-with-tool-calling primitive. The function-declaration shapes
    // mirror the JSON-Schema Zod produced for the tool DTOs — kept in sync
    // by the route handlers' Zod schemas.
    const tools = buildGeminiToolDeclarations();
    const contents = buildGeminiContents(req.history, req.message);
    const systemInstruction = armorNudge
      ? `${SYSTEM_PROMPT}\n\n${armorNudge}`
      : SYSTEM_PROMPT;

    // The @google/genai SDK is dynamically imported; we keep the call
    // surface narrow + use any-typed access to avoid pulling its types
    // into a hard dep. The wrapper validates the tool-call shape before
    // dispatching (defense against schema drift).
    type AnyClient = {
      models: {
        generateContentStream(req: {
          model: string;
          contents: unknown;
          config: {
            systemInstruction: string;
            tools: unknown[];
            toolConfig?: unknown;
          };
        }): Promise<AsyncIterable<{
          text?: string;
          functionCalls?: Array<{ name: string; args: Record<string, unknown> }>;
        }>>;
      };
    };
    const c = client as AnyClient;
    const stream = await c.models.generateContentStream({
      model: 'gemini-2.0-flash',
      contents,
      config: {
        systemInstruction,
        tools,
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      },
    });

    for await (const chunk of stream) {
      if (chunk.text) {
        sink({ type: 'text', delta: chunk.text });
      }
      if (chunk.functionCalls) {
        for (const fc of chunk.functionCalls) {
          if (!isToolName(fc.name)) {
            sink({
              type: 'tool_result',
              toolCallId: `tc_unknown_${Date.now()}`,
              toolName: fc.name,
              ok: false,
              error: `Unknown tool: ${fc.name}`,
            });
            continue;
          }
          const toolCallId = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          sink({ type: 'tool_call', toolCallId, toolName: fc.name, args: fc.args });
          try {
            const result = await req.dispatchTool(fc.name, fc.args);
            sink({
              type: 'tool_result',
              toolCallId,
              toolName: fc.name,
              ok: true,
              result: sanitiseToolResult(result),
            });
          } catch (err) {
            sink({
              type: 'tool_result',
              toolCallId,
              toolName: fc.name,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }
  }
}

/**
 * Apply PromptArmor to the user message + history. Critical-tier
 * violations on the current message hard-block; violations in history
 * are sanitised away (we never echo a known-bad pattern back into the
 * LLM context). Returns the cleaned message + history + violations
 * collected across the turn.
 */
interface ArmoredRequest {
  blocked: boolean;
  message: string;
  history: ChatHistoryMessage[];
  violations: Violation[];
  nudge: string | null;
}

function applyArmorPipeline(req: ChatStreamRequest): ArmoredRequest {
  const messageResult: PromptArmorResult = preprocessChatInput(req.message);
  if (!messageResult.allowed) {
    return {
      blocked: true,
      message: '',
      history: [],
      violations: messageResult.violations,
      nudge: null,
    };
  }

  const history: ChatHistoryMessage[] = [];
  const violations: Violation[] = [...messageResult.violations];
  for (const m of req.history) {
    const r = preprocessChatInput(m.text);
    // History entries that match a critical pattern are dropped entirely
    // (we already approved them at write-time; this is defence-in-depth
    // for any backfill / replay path).
    if (!r.allowed) {
      violations.push(...r.violations);
      continue;
    }
    violations.push(...r.violations);
    history.push({ role: m.role, text: r.sanitized });
  }

  return {
    blocked: false,
    message: messageResult.sanitized,
    history,
    violations,
    nudge: buildArmorNudge(messageResult),
  };
}

function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

/** Split text into ~32-char chunks for streamy UX in the stub path. */
function chunkText(text: string, size = 32): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function buildGeminiContents(
  history: ChatHistoryMessage[],
  current: string,
): Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> {
  const out: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
  for (const m of history) {
    out.push({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.text }],
    });
  }
  out.push({ role: 'user', parts: [{ text: current }] });
  return out;
}

/** Hand-written function declarations matching tool.dto.ts schemas. */
function buildGeminiToolDeclarations(): unknown[] {
  return [
    {
      functionDeclarations: [
        {
          name: 'muhaven_portfolio_summary',
          description:
            'Read the user\'s encrypted RWA portfolio summary. Returns positions + signal flags. No FHE decryption — handles only.',
          parameters: {
            type: 'OBJECT',
            properties: {
              tokenAddress: {
                type: 'STRING',
                description: 'Optional 0x-prefixed 40-hex token address to filter to a single position.',
              },
            },
          },
        },
        {
          name: 'muhaven_quote',
          description:
            'Quote a buy at the latest indexed NAV. Returns share estimate + maxSharesHint.',
          parameters: {
            type: 'OBJECT',
            properties: {
              tokenAddress: { type: 'STRING' },
              notionalUsd6: {
                type: 'STRING',
                description: 'USDC notional in 6-decimal units (1 USDC = 1000000).',
              },
            },
            required: ['tokenAddress', 'notionalUsd6'],
          },
        },
        {
          name: 'muhaven_propose_buy',
          description:
            'Propose an atomic Subscription.purchase. Returns an ActionDescriptor + confirm token. The user signs in <ConfirmModal>.',
          parameters: {
            type: 'OBJECT',
            properties: {
              tokenAddress: { type: 'STRING' },
              shares: { type: 'STRING', description: 'Cleartext share count (>0).' },
              maxSharesHint: { type: 'STRING' },
            },
            required: ['tokenAddress', 'shares'],
          },
        },
        {
          name: 'muhaven_propose_claim',
          description: 'Propose a yield claim from an indexed escrow.',
          parameters: {
            type: 'OBJECT',
            properties: {
              yieldRecordId: { type: 'STRING', description: 'Backend yield-record UUID.' },
            },
            required: ['yieldRecordId'],
          },
        },
        {
          name: 'muhaven_propose_rebalance',
          description: 'Propose a multi-leg rebalance (≤8 legs).',
          parameters: {
            type: 'OBJECT',
            properties: {
              legs: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    kind: { type: 'STRING', enum: ['sell', 'buy'] },
                    tokenAddress: { type: 'STRING' },
                    shares: { type: 'STRING' },
                    maxSharesHint: { type: 'STRING' },
                  },
                  required: ['kind', 'tokenAddress', 'shares'],
                },
              },
            },
            required: ['legs'],
          },
        },
        {
          name: 'muhaven_set_policy',
          description:
            'Propose a tier change. The user passkey-signs the commit through /policy/transition.',
          parameters: {
            type: 'OBJECT',
            properties: {
              surface: {
                type: 'STRING',
                enum: ['havenbot', 'mcp', 'openclaw', 'checkout'],
              },
              targetTier: {
                type: 'STRING',
                enum: ['advisory', 'confirm-per-action', 'policy-bound'],
              },
            },
            required: ['targetTier'],
          },
        },
        {
          name: 'muhaven_pause',
          description: 'Kill-switch — pause one or every agent surface (idempotent).',
          parameters: {
            type: 'OBJECT',
            properties: {
              surface: {
                type: 'STRING',
                enum: ['havenbot', 'mcp', 'openclaw', 'checkout'],
                description: 'Optional — omitting cascades across every surface.',
              },
            },
          },
        },
        {
          name: 'muhaven_unseal_position',
          description:
            'Return client-driven decrypt instructions for a CoFHE handle. Backend never decrypts.',
          parameters: {
            type: 'OBJECT',
            properties: {
              handle: { type: 'STRING' },
              signerHint: { type: 'STRING', enum: ['session', 'master'] },
            },
            required: ['handle'],
          },
        },
        // ── Wave 4 P7 — issuer-side tools ──────────────────────────────
        {
          name: 'muhaven_propose_distribute_yield',
          description:
            'Schedule a yield epoch for a registered RWA token. Wraps the @muhaven/sdk distributeYield pipeline (startDistribution → batchCreate → fundEscrows). Issuer-only.',
          parameters: {
            type: 'OBJECT',
            properties: {
              tokenAddress: { type: 'STRING' },
              totalYieldUsd6: {
                type: 'STRING',
                description:
                  'Cleartext PUSDC base units (1 USDC = 1000000). Encrypted SDK-side before submit.',
              },
              label: { type: 'STRING', description: 'Optional human-readable label.' },
            },
            required: ['tokenAddress', 'totalYieldUsd6'],
          },
        },
        {
          name: 'muhaven_propose_kyc_add',
          description:
            'Add an investor to the ERC-3643 whitelist for a token (tier 1 = retail KYC; tier 2 = accredited). Issuer-only.',
          parameters: {
            type: 'OBJECT',
            properties: {
              tokenAddress: { type: 'STRING' },
              investorAddress: { type: 'STRING' },
              kycTier: { type: 'NUMBER', enum: [1, 2] },
            },
            required: ['tokenAddress', 'investorAddress'],
          },
        },
        {
          name: 'muhaven_propose_kyc_remove',
          description:
            'Remove an investor from the ERC-3643 whitelist for a token (tier-2 accredited status auto-cleared). Issuer-only.',
          parameters: {
            type: 'OBJECT',
            properties: {
              tokenAddress: { type: 'STRING' },
              investorAddress: { type: 'STRING' },
            },
            required: ['tokenAddress', 'investorAddress'],
          },
        },
        {
          name: 'muhaven_propose_unpause_token',
          description:
            'Set initial NAV + unpause a freshly-deployed token (closes the F2 wizard step 6). Issuer-only.',
          parameters: {
            type: 'OBJECT',
            properties: {
              tokenAddress: { type: 'STRING' },
              initialNavUsd6: {
                type: 'STRING',
                description: 'Initial NAV in PUSDC base units (6 decimals). 1000000 = $1.00.',
              },
            },
            required: ['tokenAddress', 'initialNavUsd6'],
          },
        },
        {
          name: 'muhaven_audit_query',
          description:
            'Return the calling user\'s own tiered-autonomy audit log entries (cursor-paginated). Useful for forensic review and compliance. Wave 4 = issuer-self only; Wave 5 will add permit-gated cross-user access.',
          parameters: {
            type: 'OBJECT',
            properties: {
              surface: {
                type: 'STRING',
                enum: ['havenbot', 'mcp', 'openclaw', 'checkout'],
              },
              eventTypes: {
                type: 'ARRAY',
                items: {
                  type: 'STRING',
                  enum: [
                    'tier_changed',
                    'paused',
                    'resumed',
                    'cron_tick',
                    'confirm_token_issued',
                    'confirm_token_consumed',
                    'permit_granted',
                    'permit_revoked',
                    'validator_installed',
                    'validator_uninstalled',
                    'kyc_revocation_received',
                    'risk_questionnaire_complete',
                  ],
                },
              },
              since: { type: 'STRING', description: 'ISO datetime — inclusive lower bound.' },
              until: { type: 'STRING', description: 'ISO datetime — inclusive upper bound.' },
              cursor: { type: 'STRING' },
              limit: { type: 'NUMBER' },
            },
          },
        },
      ],
    },
  ];
}
