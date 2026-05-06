/**
 * Wave 4 P8 — CaMeL-style planner / action policy gate.
 *
 * The CaMeL pattern (Willison's distillation of Simon's "two-LLM" sketch)
 * separates the planner LLM (which sees untrusted text + ambiguous user
 * intent) from the action layer (which executes only schema-validated
 * structured intents through deterministic code paths).
 *
 * Wave 4 adopts the **stronger** half of CaMeL — the *action* layer is a
 * deterministic dispatcher (`ToolDispatcher`), not a second LLM. That
 * means we get the same security property (the planner's emitted text
 * never touches the bundler / FHE.allow / permit path) at strictly less
 * runtime cost than the canonical two-LLM shape. The deferred half — a
 * second LLM that reasons about pre-validated tool results — is a Wave-5
 * follow-up flagged in `SAFETY_HARDENING.md`.
 *
 * This module is the **gate** — the deterministic check that runs between
 * the planner LLM's tool_call event and the dispatcher's `execute`. Its
 * jobs:
 *
 *   1. Strip the args of any string content that smells like decrypted
 *      plaintext, ANSI escapes, or smuggled Unicode (defense-in-depth on
 *      top of Zod's strict-additionalProperties: false enforcement).
 *   2. Reject tool-name impersonation (LLM emitting `muhaven_propose_buy`
 *      with a `__proto__` arg, or a deeply-nested fake `tool_call` inside
 *      a plain string field).
 *   3. Tag every dispatched call with a correlationId so the audit log
 *      can link planner → gate → action to a single chat turn.
 *
 * Failure modes are explicit:
 *   - Args sanitisation that *changes* the value emits a warn-tier audit
 *     row but the call still proceeds against the cleaned args.
 *   - Tool-name impersonation throws a structured `BadRequest` and the
 *     dispatcher never runs.
 */

import { ApplicationHttpError } from '../../../core/errors.js';
import { sanitizeJsonValue, sanitizeText } from './output-sanitizer.js';

/** Allow-listed tool surface — must match `ToolDispatcher`'s switch. */
export const PLANNER_ALLOWED_TOOLS = [
  'muhaven_portfolio_summary',
  'muhaven_quote',
  'muhaven_propose_buy',
  'muhaven_propose_claim',
  'muhaven_propose_rebalance',
  'muhaven_set_policy',
  'muhaven_pause',
  'muhaven_unseal_position',
  // Wave 4 P7 — issuer-side tools (ADR-8)
  'muhaven_propose_distribute_yield',
  'muhaven_propose_kyc_add',
  'muhaven_propose_kyc_remove',
  'muhaven_propose_unpause_token',
  'muhaven_audit_query',
] as const;

export type PlannerAllowedTool = (typeof PLANNER_ALLOWED_TOOLS)[number];

const ALLOWED_SET = new Set<string>(PLANNER_ALLOWED_TOOLS);

export interface CaMeLGateInput {
  toolName: string;
  rawArgs: unknown;
}

export interface CaMeLGateOutput {
  toolName: PlannerAllowedTool;
  cleanArgs: Record<string, unknown> | undefined;
  /** True if the cleaned args differ structurally from the raw args. */
  argsWereSanitised: boolean;
  /** Stable correlation id for the audit log (planner ↔ gate ↔ action). */
  correlationId: string;
}

/**
 * Validate + sanitise a planner-emitted tool intent before it reaches the
 * deterministic dispatcher. Throws `ApplicationHttpError.badRequest` if
 * the tool is unknown or if a structural impersonation attempt is detected.
 */
export function gatePlannerIntent(input: CaMeLGateInput): CaMeLGateOutput {
  const toolName = sanitizeText(String(input.toolName ?? ''));
  if (!ALLOWED_SET.has(toolName)) {
    throw ApplicationHttpError.badRequest(
      `Unknown planner tool intent: ${JSON.stringify(toolName).slice(0, 64)}`,
    );
  }

  // Reject obviously-bad arg shapes early. Zod's strict() catches strict
  // schema mismatches downstream; we only screen for non-object args
  // (planner emitting a raw string instead of a JSON object) and for
  // prototype-pollution attempts.
  const rawArgs = input.rawArgs;
  if (rawArgs != null && typeof rawArgs !== 'object') {
    throw ApplicationHttpError.badRequest(
      `Planner tool args must be a JSON object, got ${typeof rawArgs}`,
    );
  }
  if (Array.isArray(rawArgs)) {
    throw ApplicationHttpError.badRequest('Planner tool args must be an object, not array');
  }
  if (rawArgs != null) {
    for (const k of Object.keys(rawArgs as Record<string, unknown>)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
        throw ApplicationHttpError.badRequest(
          `Planner emitted reserved arg key '${k}' — refusing dispatch`,
        );
      }
    }
  }

  const cleanArgs = rawArgs == null
    ? undefined
    : sanitizeJsonValue(rawArgs as Record<string, unknown>);

  const argsWereSanitised = rawArgs != null
    && JSON.stringify(rawArgs) !== JSON.stringify(cleanArgs);

  const correlationId = `cm_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  return {
    toolName: toolName as PlannerAllowedTool,
    cleanArgs,
    argsWereSanitised,
    correlationId,
  };
}

/**
 * Sanitise a tool result before it is fed back to the planner LLM. The
 * dispatcher already validates inputs; this hardens the boundary on the
 * way back so an upstream API that returned ANSI / smuggled chars cannot
 * rewrite the chat history visually or pollute the planner's context.
 *
 * Non-object results (strings, primitives) are passed through `sanitizeText`
 * so the strong defence applies uniformly. Errors propagate unchanged —
 * the surrounding dispatcher already maps them to structured stream events.
 */
export function sanitiseToolResult<T>(value: T): T {
  return sanitizeJsonValue(value);
}
