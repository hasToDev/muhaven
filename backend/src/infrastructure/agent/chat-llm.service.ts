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
import {
  buildSuggestions,
  FALLBACK_SUGGESTIONS,
  type SuggestionContext,
} from './suggestion-builder.js';

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

export interface TokenCatalogEntry {
  symbol: string;
  address: string;
  assetClass?: string;
  status?: string;
}

export interface ChatStreamRequest {
  userId: string;
  walletAddress: string;
  surface: Surface;
  currentTier: Tier;
  message: string;
  history: ChatHistoryMessage[];
  /** Active RWA tokens registered on-chain at request time. Used to
   *  enrich the system prompt with the symbol→address map so the LLM
   *  can resolve "Quote 100 mhUSDC of TBILL1" without prompting the
   *  user for the address. Pulled from `IRwaTokenRepository.findAll`
   *  in the route handler — kept on the request so the service stays
   *  stateless + easy to mock in tests. */
  tokenCatalog?: TokenCatalogEntry[];
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
  // Wave 4 P11 — protection / governance / KYC tools (ADR-9). Read tools
  // surface on-chain proxy state to the LLM; propose tools mint an
  // ActionDescriptor that the ConfirmModal handles. The cast_encrypted_vote
  // runner branch is deferred to Wave 5 (encrypt-vote SDK helper not yet
  // published) — backend propose path is live so the LLM can still reach it
  // and the modal will surface the deferred state.
  'muhaven_check_protection_coverage',
  'muhaven_explain_kyc_attestation',
  'muhaven_propose_governance_vote',
  'muhaven_cast_encrypted_vote',
  // Wave 4 §5 Path C — hosted-checkout session mint via agent. Issuer-only;
  // the lifecycle gate + token-of-record check happen inside the use-case.
  // ConfirmModal renders the cleartext preview; commit returns the buyer URL.
  'muhaven_propose_create_checkout',
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

YOUR CAPABILITIES (issuer-only checkout tool — tier-gated)
- muhaven_propose_create_checkout(tokenAddress, amountUsd6, memo?, successUrl?, cancelUrl?): Mint a hosted-checkout session for an investor to pay in mhUSDC. Returns an ActionDescriptor; the issuer authorizes in ConfirmModal and the commit returns a buyer URL (pay.muhaven.app/c/cs_...#k=...) which the issuer shares with the buyer.

YOUR CAPABILITIES (protection / governance / KYC — read tools, no policy gate)
- muhaven_check_protection_coverage(tokenAddress): Read on-chain DefaultProtection state for a token. Returns status (no_protection / inactive / active / triggered / distributing / completed / not_deployed) + reserveRateBps + a cleartext explanation. Backend never decrypts the encrypted reserve handle.
- muhaven_explain_kyc_attestation(investorAddress?): Describe the cross-chain KYC attestation flow + the attestation registry's public state. Defaults to the calling user's wallet.

YOUR CAPABILITIES (governance write tools — tier-gated)
- muhaven_propose_governance_vote(tokenAddress, proposalType): Open an EncryptedGovernance proposal (Wave 4 supports proposalType=0 TRIGGER_PROTECTION; type=1 reserved for Wave 5).
- muhaven_cast_encrypted_vote(proposalId, voteYes): Cast an encrypted yes/no vote on an existing proposal. The SDK encrypts the vote client-side; the agent never sees the encrypted handle. Wave 4: backend propose works, frontend runner deferred to Wave 5.

YOUR CONSTRAINTS
- NEVER bypass the policy gate. NEVER call signing endpoints directly.
- NEVER reveal another user's portfolio data — every encrypted handle requires a permit signed by the data owner.
- NEVER suggest actions outside the user's current tier; instead suggest raising the tier (muhaven_set_policy) which the user signs separately.
- You are NOT a financial advisor — you provide tools and information.
- All balances, amounts, and risk parameters are FHE-encrypted on-chain. You operate on encrypted state through tool surfaces; you never decrypt directly.

PROPOSE-BUY FRAMING
- After a successful muhaven_propose_buy tool call, DO NOT promise the
  purchase will go through ("Please sign the transaction" / "the
  purchase has been initiated"). The user's mhUSDC balance is FHE-
  encrypted; you have no way to verify it has sufficient funds. The
  dashboard ConfirmModal performs a client-side decrypt + balance
  check at Authorize time and may refuse the buy ("Insufficient
  mhUSDC balance: have $5.00, need $100.00").
- Phrase your reply cautiously: "I've prepared a buy proposal for
  100 mhUSDC of TBILL1. Open the confirmation in the dashboard to
  review the preview and authorize. If your mhUSDC balance is too
  low for this purchase, the dashboard will refuse and offer to
  wrap more USDC first."
- If the propose_buy throws INSUFFICIENT_MHUSDC, apologise and
  suggest wrapping mhUSDC on the Cash page. Don't try the proposal
  again until the user confirms they've wrapped.

PRIVACY PRINCIPLE
Your strategy, the user's strategy, and the encrypted state itself are private. Nobody else — not competitors, not MEV bots, not operator infra, not the LLM provider, not even you — can see the portfolio without an explicit user-signed permit.`;

/**
 * Build a "KNOWN TOKENS" addendum from the active RWA catalog. The
 * planner LLM uses this to resolve "Quote 100 mhUSDC of TBILL1" → a
 * concrete `tokenAddress` without having to ask the user. The list
 * comes from `IRwaTokenRepository` at request time so the section
 * stays correct across staging vs prod redeployments (token
 * addresses rotate per environment).
 */
function buildTokenCatalogSection(catalog: TokenCatalogEntry[] | undefined): string {
  if (!catalog || catalog.length === 0) return '';
  const lines = catalog.map((t) => {
    const status = t.status && t.status !== 'active' ? ` [${t.status}]` : '';
    const cls = t.assetClass ? ` (${t.assetClass})` : '';
    return `- ${t.symbol}: ${t.address}${cls}${status}`;
  });
  return `\n\nKNOWN TOKENS (resolve symbol → tokenAddress without asking the user):\n${lines.join('\n')}\nWhen the user names a symbol (e.g. "TBILL1"), pass the matching address into tool calls. If the symbol is not in this list, ask the user for the address rather than guessing.`;
}

/**
 * Lazy-instantiate the Gemini client only when the key is set, so the
 * backend boots fine without it. We dynamic-import the SDK so cold-start
 * dev environments without `@google/genai` installed still work — the
 * stub fallback just kicks in.
 */
let _geminiClient: unknown = null;
let _geminiAttempted = false;

/**
 * Test-only reset hook. The lazy load + cached client are critical for
 * production cold-start performance; in tests we need to flip between
 * "no key (stub)" and "key + mock SDK (Gemini)" within a single suite.
 * Exposed under a `__` prefix so it never trips IDE autocomplete on the
 * non-test consumer side.
 */
export function __resetGeminiCacheForTests(): void {
  _geminiClient = null;
  _geminiAttempted = false;
}

async function tryLoadGemini(): Promise<unknown | null> {
  if (_geminiAttempted) return _geminiClient;
  _geminiAttempted = true;
  const key = getEnv().GEMINI_API_KEY;
  if (!key) return null;
  try {
    // Dynamic import keeps the cold-start path lean — no SDK overhead
    // when GEMINI_API_KEY is unset (the common case in dev / CI). The
    // package is a hard dep since 2026-05-09; pre-2026-05-09 cold-start
    // dev environments without the install fall through the catch.
    const mod = (await import('@google/genai')) as {
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
      '@google/genai dynamic import failed — using stub fallback. Run `pnpm install` in backend/ if the package is missing.',
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
  // Default fallback when the message didn't match a stub-classifier
  // keyword. The full capabilities list is intentionally NOT surfaced
  // here — the stub only supports `portfolio` / `pause` keywords; listing
  // buys/claims/rebalances/policy-tier-changes would be misleading
  // because none of those routes work without the Gemini loop. Keep this
  // copy honest: tell the user the agent is degraded so they don't burn
  // time crafting prompts that can't succeed.
  return {
    text:
      'The agent is temporarily unavailable. Please try again in a moment.',
  };
}

/**
 * Hard cap on round-trip turns inside `runGeminiLoop`. One turn is "stream
 * model → dispatch any tool calls → re-stream with function responses".
 * Three turns lets the model fix a wrong-arg call once + still synthesize
 * a final answer; higher limits open a chain-call DoS surface (R-2).
 */
const MAX_TOOL_TURNS = 3;

/**
 * Strip privileged fields from an ActionDescriptor before re-feeding it to
 * the LLM as a `functionResponse`. The LLM should be able to *describe*
 * the proposed action ("here's a buy proposal for 100 mhUSDC of TBILL1")
 * without ever seeing or speaking the single-use confirm token (R-3) or
 * the raw `sdkCall` wire-shape internals.
 */
function stripPrivilegedActionFields(value: unknown): unknown {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => stripPrivilegedActionFields(v));
  const obj = value as Record<string, unknown>;
  // Only ActionDescriptor-shaped objects carry confirmTokenId + sdkCall;
  // leaving non-Action results untouched preserves read-tool richness
  // (positions[], NAV, audit pages) for the synthesis turn.
  const isActionDescriptor =
    typeof obj.kind === 'string'
    && typeof obj.toolCallId === 'string'
    && typeof obj.confirmTokenId === 'string'
    && typeof obj.sdkCall === 'object';
  if (!isActionDescriptor) return obj;
  const { confirmTokenId: _ct, sdkCall: _sdk, ...rest } = obj;
  return rest;
}

/**
 * Deterministic per-tool synthesis used by `runStubLoop` post-dispatch.
 * Mirrors what the LLM would say after a successful read-tool call so the
 * stub UX matches the agentic loop's UX. Returns null when no synthesis is
 * appropriate (e.g. propose_* tools whose ConfirmModal is the next surface).
 */
export function summarizeStubToolResult(
  toolName: ToolName,
  result: unknown,
): string | null {
  if (result == null || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;

  switch (toolName) {
    case 'muhaven_portfolio_summary': {
      const total = typeof r.totalPositions === 'number' ? r.totalPositions : 0;
      if (total === 0) {
        return (
          'You currently hold no RWA positions. Once you make your first deposit '
          + 'and buy on the Cash page, your encrypted balances will appear here.'
        );
      }
      const positions = Array.isArray(r.positions) ? r.positions : [];
      const symbols = positions
        .map((p) => (p as { tokenSymbol?: string }).tokenSymbol)
        .filter((s): s is string => typeof s === 'string')
        .join(', ');
      const sigNote =
        typeof (r.signals as { note?: string } | undefined)?.note === 'string'
          ? ` ${(r.signals as { note: string }).note}`
          : '';
      return `You hold ${total} position${total === 1 ? '' : 's'}${symbols ? ` (${symbols})` : ''}.${sigNote}`;
    }
    case 'muhaven_quote': {
      const symbol = typeof r.tokenSymbol === 'string' ? r.tokenSymbol : 'token';
      const navUsd6 = typeof r.navUsd6 === 'string' ? r.navUsd6 : null;
      const shares = typeof r.estimatedShares === 'string' ? r.estimatedShares : null;
      if (!navUsd6 || !shares) return 'Quote returned, but the NAV or share estimate was unavailable.';
      const navUsd = (Number(navUsd6) / 1_000_000).toFixed(4);
      return `At a NAV of $${navUsd} per share, that buys roughly ${shares} ${symbol}.`;
    }
    case 'muhaven_unseal_position':
      return 'Decrypt instruction prepared — the dashboard will perform the client-side reveal with your passkey permit.';
    case 'muhaven_audit_query': {
      const total = typeof r.totalCount === 'number' ? r.totalCount : null;
      return total === null
        ? 'Audit query returned. Open the audit page for the full list.'
        : `Audit query matched ${total} entr${total === 1 ? 'y' : 'ies'} in the requested window.`;
    }
    case 'muhaven_check_protection_coverage': {
      // The use-case already builds a cleartext, narrative `explanation`
      // for every status branch (not_deployed / no_protection / inactive /
      // active / triggered / distributing / completed). Re-using it keeps
      // the stub UX aligned with what Gemini would emit if it picked up
      // the same tool result.
      const explanation = typeof r.explanation === 'string' ? r.explanation : null;
      if (explanation) return explanation;
      const status = typeof r.status === 'string' ? r.status : 'unknown';
      return `Protection coverage status: ${status}.`;
    }
    case 'muhaven_explain_kyc_attestation': {
      const narrative = typeof r.narrative === 'string' ? r.narrative : null;
      if (narrative) return narrative;
      const status = typeof r.status === 'string' ? r.status : 'unknown';
      return `KYC attestation registry status: ${status}.`;
    }
    // propose_* tools surface their preview through the ConfirmModal — no
    // synthesis needed. The user sees the modal as the agent's "reply".
    case 'muhaven_propose_buy':
    case 'muhaven_propose_claim':
    case 'muhaven_propose_rebalance':
    case 'muhaven_set_policy':
    case 'muhaven_pause':
    case 'muhaven_propose_distribute_yield':
    case 'muhaven_propose_kyc_add':
    case 'muhaven_propose_kyc_remove':
    case 'muhaven_propose_unpause_token':
    case 'muhaven_propose_governance_vote':
    case 'muhaven_cast_encrypted_vote':
    case 'muhaven_propose_create_checkout':
      return null;
    default:
      return null;
  }
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

    sink({ type: 'meta', model: getEnv().GEMINI_MODEL, sessionId });
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

    // Fake-stream the pre-tool text so the UX matches the LLM path.
    for (const chunk of chunkText(text)) {
      sink({ type: 'text', delta: chunk });
    }

    if (!toolCall) {
      // No tool fired. Emit fallback suggestions so the chat surface
      // still has actionable chips below the reply.
      sink({ type: 'suggestions', items: FALLBACK_SUGGESTIONS });
      return;
    }

    const toolCallId = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sink({ type: 'tool_call', toolCallId, toolName: toolCall.toolName, args: toolCall.args });
    const suggestionCtx: SuggestionContext = {
      lastTool: toolCall.toolName,
      tokenSymbol:
        typeof toolCall.args.tokenAddress === 'string'
          ? null /* stub doesn't have a registry → omit */
          : null,
    };
    try {
      const result = await req.dispatchTool(toolCall.toolName, toolCall.args);
      const sanitisedResult = sanitiseToolResult(result);
      sink({
        type: 'tool_result',
        toolCallId,
        toolName: toolCall.toolName,
        ok: true,
        result: sanitisedResult,
      });
      suggestionCtx.lastResult = sanitisedResult;
      // Post-dispatch synthesis — without it the stub leaves the user
      // staring at the pre-tool sentence while the actual data (or the
      // empty-portfolio case) goes unannounced. Mirrors what the LLM
      // would say after seeing the function response.
      const synthesised = summarizeStubToolResult(toolCall.toolName, sanitisedResult);
      if (synthesised) {
        for (const chunk of chunkText(`\n\n${synthesised}`)) {
          sink({ type: 'text', delta: chunk });
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      sink({
        type: 'tool_result',
        toolCallId,
        toolName: toolCall.toolName,
        ok: false,
        error: errorMsg,
      });
      suggestionCtx.lastError = errorMsg;
      for (const chunk of chunkText(
        `\n\nThe ${toolCall.toolName} tool failed: ${errorMsg}.`,
      )) {
        sink({ type: 'text', delta: chunk });
      }
    }
    sink({ type: 'suggestions', items: buildSuggestions(suggestionCtx) });
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
    const catalogSection = buildTokenCatalogSection(req.tokenCatalog);
    const promptWithCatalog = `${SYSTEM_PROMPT}${catalogSection}`;
    const systemInstruction = armorNudge
      ? `${promptWithCatalog}\n\n${armorNudge}`
      : promptWithCatalog;

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

    // Agentic round-trip loop. Each turn the model can emit text + zero or
    // more functionCalls; if any tools fire we dispatch them, append the
    // model's call-turn + a synthetic user turn carrying the function
    // responses, then re-stream so the model can synthesise a final
    // answer ("you hold no positions yet"). Without this loop the user
    // sees the tool fire but no result-aware reply.
    const model = getEnv().GEMINI_MODEL;
    // Track the last tool dispatch outcome across turns so the
    // suggestions emitted at the end reflect what actually happened
    // (per `suggestion-builder.ts`). The frontend ActionCard reads
    // these chips; they default to FALLBACK_SUGGESTIONS when no tool
    // fires across the entire turn.
    const suggestionCtx: SuggestionContext = {};
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const stream = await c.models.generateContentStream({
        model,
        contents,
        config: {
          systemInstruction,
          tools,
          toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        },
      });

      const turnFunctionCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
      const turnFunctionResponses: Array<{ name: string; response: unknown }> = [];

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
              const sanitisedResult = sanitiseToolResult(result);
              sink({
                type: 'tool_result',
                toolCallId,
                toolName: fc.name,
                ok: true,
                result: sanitisedResult,
              });
              turnFunctionCalls.push({ name: fc.name, args: fc.args });
              // Strip privileged fields before re-feeding to the LLM so
              // the model can describe a propose_buy preview without ever
              // seeing or speaking the single-use confirm token.
              const llmVisible = stripPrivilegedActionFields(sanitisedResult);
              turnFunctionResponses.push({ name: fc.name, response: llmVisible });
              // Latest-tool-wins for suggestion mapping — covers the
              // common shape of one tool per turn. Multi-tool turns
              // overwrite; that's fine because the user-facing chips
              // should reflect the last thing they saw.
              suggestionCtx.lastTool = fc.name;
              suggestionCtx.lastResult = sanitisedResult;
              suggestionCtx.lastError = undefined;
              suggestionCtx.tokenSymbol =
                typeof fc.args.tokenSymbol === 'string' ? fc.args.tokenSymbol : null;
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              sink({
                type: 'tool_result',
                toolCallId,
                toolName: fc.name,
                ok: false,
                error: errorMsg,
              });
              // Feed the failure back so the model can apologise + suggest
              // a recovery rather than dropping the user mid-turn.
              turnFunctionCalls.push({ name: fc.name, args: fc.args });
              turnFunctionResponses.push({
                name: fc.name,
                response: { error: errorMsg },
              });
              suggestionCtx.lastTool = fc.name;
              suggestionCtx.lastError = errorMsg;
              suggestionCtx.lastResult = undefined;
            }
          }
        }
      }

      if (turnFunctionResponses.length === 0) {
        // No tools fired (or model produced text-only) — turn is done.
        // Emit suggestions based on the most recent tool outcome (which
        // may be from an earlier turn) or fallback if no tool ever fired.
        sink({
          type: 'suggestions',
          items: suggestionCtx.lastTool ? buildSuggestions(suggestionCtx) : FALLBACK_SUGGESTIONS,
        });
        return;
      }

      // Append the model's call turn and the synthetic tool-response turn,
      // then loop. The Gemini @google/genai SDK accepts function responses
      // as `role: 'user'` parts containing `functionResponse` (not
      // `role: 'tool'` — that shape is for the older Vertex SDK).
      contents.push({
        role: 'model',
        parts: turnFunctionCalls.map((fc) => ({ functionCall: fc })),
      });
      contents.push({
        role: 'user',
        parts: turnFunctionResponses.map((fr) => ({ functionResponse: fr })),
      });
    }

    // Hit the cap. Surface a polite tail so the chat doesn't end on a
    // tool_result with no commentary; the user can re-prompt to continue.
    sink({
      type: 'text',
      delta:
        '\n\nI\'ve reached my action budget for this turn. Ask me anything else and I\'ll pick up from here.',
    });
    sink({
      type: 'suggestions',
      items: suggestionCtx.lastTool ? buildSuggestions(suggestionCtx) : FALLBACK_SUGGESTIONS,
    });
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

/**
 * Gemini content part — text, functionCall, or functionResponse. The
 * @google/genai SDK accepts a heterogeneous mix per turn; we keep the
 * type wide so the agentic round-trip in `runGeminiLoop` can append
 * call-turn + response-turn parts without separate cast sites.
 */
type GeminiContentPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: unknown } };

type GeminiContent = { role: 'user' | 'model'; parts: GeminiContentPart[] };

function buildGeminiContents(
  history: ChatHistoryMessage[],
  current: string,
): GeminiContent[] {
  const out: GeminiContent[] = [];
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
                  'Cleartext mhUSDC base units (1 mhUSDC = 1000000). Encrypted SDK-side before submit.',
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
              // kycTier is a 1|2 union per `ProposeKycAddDtoSchema`, but
              // Gemini's function-declaration schema requires `enum` values
              // to be strings even when `type: 'NUMBER'` (per Google's
              // protobuf spec — surfaced 2026-05-09 by a 400 from
              // generativelanguage.googleapis.com). Drop the enum and let
              // Zod's union literal catch out-of-range values server-side;
              // the description tells the LLM what's valid.
              kycTier: {
                type: 'NUMBER',
                description: 'KYC tier — 1 (retail) or 2 (accredited). Defaults to 1.',
              },
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
                description: 'Initial NAV in mhUSDC base units (6 decimals). 1000000 = $1.00.',
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
        // ── Wave 4 P11 — protection / governance / KYC tools (ADR-9) ──
        {
          name: 'muhaven_check_protection_coverage',
          description:
            'Read on-chain DefaultProtection state for an RWA token. Returns status (no_protection / inactive / active / triggered / distributing / completed / not_deployed), reserveRateBps, issuerAddress, and a cleartext explanation. Backend never decrypts the encrypted reserve handle.',
          parameters: {
            type: 'OBJECT',
            properties: {
              tokenAddress: {
                type: 'STRING',
                description: '0x-prefixed 40-hex RWA token address (resolve symbols like TBILL1 via the KNOWN TOKENS list).',
              },
            },
            required: ['tokenAddress'],
          },
        },
        {
          name: 'muhaven_explain_kyc_attestation',
          description:
            'Explain the cross-chain KYC attestation flow + read the public KYCAttestationRegistry state (jurisdictionHash, defaultValidityPeriodSec, attestationSigner). Defaults to the calling user\'s wallet when investorAddress is omitted.',
          parameters: {
            type: 'OBJECT',
            properties: {
              investorAddress: {
                type: 'STRING',
                description: 'Optional 0x-prefixed 40-hex investor address. Defaults to the calling user.',
              },
            },
          },
        },
        {
          name: 'muhaven_propose_governance_vote',
          description:
            'Open an EncryptedGovernance proposal for a token. proposalType=0 = TRIGGER_PROTECTION (Wave 4 supported); proposalType=1 reserved for Wave 5. Returns an ActionDescriptor the user authorizes in the ConfirmModal.',
          parameters: {
            type: 'OBJECT',
            properties: {
              tokenAddress: { type: 'STRING' },
              proposalType: {
                type: 'NUMBER',
                description: 'Encoded proposal type — 0 (TRIGGER_PROTECTION) or 1 (reserved Wave 5).',
              },
            },
            required: ['tokenAddress', 'proposalType'],
          },
        },
        {
          name: 'muhaven_cast_encrypted_vote',
          description:
            'Cast an encrypted yes/no vote on an existing EncryptedGovernance proposal. The SDK encrypts client-side. Wave 4: backend propose works; the frontend runner is deferred to Wave 5 once the encrypt-vote SDK helper ships.',
          parameters: {
            type: 'OBJECT',
            properties: {
              proposalId: {
                type: 'STRING',
                description: 'Positive-integer proposal id minted by EncryptedGovernance.createProposal.',
              },
              voteYes: { type: 'BOOLEAN' },
            },
            required: ['proposalId', 'voteYes'],
          },
        },
        // ── Wave 4 §5 Path C — hosted-checkout via agent ──────────────
        {
          name: 'muhaven_propose_create_checkout',
          description:
            'Mint a hosted-checkout session for an issuer to share with an investor. The buyer pays in mhUSDC; the session encrypts the amount client-side via a URL fragment key. Returns an ActionDescriptor with cleartext preview rows; ConfirmModal authorizes, commit returns the buyer URL.',
          parameters: {
            type: 'OBJECT',
            properties: {
              tokenAddress: {
                type: 'STRING',
                description: '0x-prefixed 40-hex RWA token address (resolve symbols like AURA88 via KNOWN TOKENS list).',
              },
              amountUsd6: {
                type: 'STRING',
                description: 'Cleartext mhUSDC base units (1 mhUSDC = 1000000). Positive integer string.',
              },
              memo: {
                type: 'STRING',
                description: 'Optional human-readable memo shown on the buyer page (≤280 chars).',
              },
              successUrl: {
                type: 'STRING',
                description: 'Optional post-success redirect URL (≤512 chars). Must be https:// (or http://localhost for dev). javascript:/data:/file: schemes are rejected.',
              },
              cancelUrl: {
                type: 'STRING',
                description: 'Optional cancel-redirect URL. Same scheme rules as successUrl (https:// only, with localhost dev allowance).',
              },
            },
            required: ['tokenAddress', 'amountUsd6'],
          },
        },
      ],
    },
  ];
}
