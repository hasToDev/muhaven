/**
 * Tool handlers — pure functions of `(input, deps)` returning a structured
 * tool result. The MCP server transport layer (`src/server.ts`) wires
 * these to the host LLM via `@modelcontextprotocol/sdk`.
 *
 * Design notes:
 *  - Handlers NEVER throw. They translate every error into a structured
 *    `{ ok: false, code, message }` payload so the host LLM can decide
 *    how to surface it without crashing the MCP server. This matches the
 *    MCPB error-presentation convention.
 *  - Position handlers DO NOT submit UserOps. They return an unsigned
 *    envelope plus a broker signature; the host (or the MuHaven
 *    dashboard via deep-link) is responsible for bundler submission.
 *    Splitting submission from signing is the lethal-trifecta defense.
 *  - Backend errors with status >= 500 are surfaced as `server_error`
 *    so the host can retry; client errors (4xx) bubble up as the
 *    discriminating code (`unauthorized`, `forbidden`, etc.). The host
 *    MUST NOT auto-retry 4xx.
 */

import type { BackendClient } from '../clients/backend-client.js';
import { BackendError } from '../clients/backend-client.js';
import type { BrokerClient } from '../clients/broker-client.js';
import { BrokerClientError } from '../clients/broker-client.js';
import {
  authRequiredPayload,
  sessionKeyRequiredPayload,
  type AuthRequiredPayload,
  type SessionKeyRequiredPayload,
} from './auth-required.js';
import type {
  PolicyAuditExportInput,
  PolicyPauseInput,
  PolicySetTierInput,
  PolicySessionKeyStatusInput,
  PositionBuyInput,
  PositionClaimInput,
  PositionRebalanceInput,
  PositionSellInput,
  ReadAuditInput,
  ReadDistributionInput,
  ReadPortfolioInput,
  ReadTokensInput,
  ReadYieldsInput,
  // Wave 4 P7 — issuer group
  IssuerDistributeYieldInput,
  IssuerKycAddInput,
  IssuerKycRemoveInput,
  IssuerUnpauseTokenInput,
  IssuerAuditQueryInput,
  // Wave 4 P11 — governance / protection / KYC group
  ReadProtectionCoverageInput,
  ReadKycAttestationInput,
  GovernanceProposeInput,
  GovernanceCastVoteInput,
} from './schemas.js';

export interface ToolDeps {
  backend: BackendClient;
  broker?: BrokerClient;
  /** Surface this MCP server is configured for. Always 'mcp' here, but
   *  carried as a dep so the audit tool can filter to the local surface. */
  surface: 'mcp';
  /**
   * Dashboard base URL — used to build the mint-URL surfaced in the
   * `SESSION_KEY_REQUIRED` payload when the broker is in read-only
   * posture. Optional for back-compat; the payload falls back to the
   * production default when absent.
   */
  dashboardBaseUrl?: string;
}

export type ToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string }
  // Special unauthorized payload — adds `loginCommand` so the host LLM
  // can present the device-flow CLI without parsing message strings.
  | AuthRequiredPayload
  // Sibling discriminator — broker is reachable but has no session key.
  // Distinct from AUTH_REQUIRED so the LLM doesn't suggest the wrong
  // remediation path (login mints a JWT; this needs a dashboard ceremony).
  | SessionKeyRequiredPayload;

function ok<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}

function err(code: string, message: string): ToolResult<never> {
  return { ok: false, code, message };
}

/**
 * `unauthorized` is a special case. The handler swallows the BackendError
 * (every public handler wraps in try/catch+mapBackendError), which means
 * the same-named branch in `server.ts` never observes it. We surface the
 * structured AUTH_REQUIRED payload here so the host LLM can present the
 * `muhaven-broker login` instruction without parsing the message string.
 *
 * P10 bug bash — discovered by `mcp-redteam.test.ts`'s "AUTH_REQUIRED with
 * login command" case which previously asserted `code: 'AUTH_REQUIRED'`
 * and saw `code: 'backend.unauthorized'` instead.
 */
function mapBackendError(e: unknown): ToolResult<never> {
  if (e instanceof BackendError) {
    // Special-case unauthorized: every handler swallows BackendError via
    // mapBackendError, so the same-named branch in `server.ts` never fires
    // for handler-routed unauthorized errors. Returning the structured
    // AUTH_REQUIRED payload here keeps the host LLM's contract uniform —
    // it only ever needs to look for `code: 'AUTH_REQUIRED'` to know it
    // should surface the `muhaven-broker login` instruction.
    if (e.code === 'unauthorized') return authRequiredPayload();
    return err(`backend.${e.code}`, e.message);
  }
  if (e instanceof Error) return err('backend.network', e.message);
  return err('backend.network', 'unknown backend error');
}

function mapBrokerError(e: unknown): ToolResult<never> {
  if (e instanceof BrokerClientError) return err(`broker.${e.code}`, e.message);
  if (e instanceof Error) return err('broker.network', e.message);
  return err('broker.network', 'unknown broker error');
}

// ---------- read group ----------

export async function readPortfolio(
  _input: ReadPortfolioInput,
  deps: ToolDeps,
): Promise<ToolResult<unknown>> {
  try {
    const data = await deps.backend.get('/api/v1/portfolio');
    return ok(data);
  } catch (e) {
    return mapBackendError(e);
  }
}

export async function readYields(
  input: ReadYieldsInput,
  deps: ToolDeps,
): Promise<ToolResult<unknown>> {
  try {
    const data = await deps.backend.get('/api/v1/yields', {
      token: input.token,
      limit: input.limit,
    });
    return ok(data);
  } catch (e) {
    return mapBackendError(e);
  }
}

export async function readDistribution(
  input: ReadDistributionInput,
  deps: ToolDeps,
): Promise<ToolResult<unknown>> {
  try {
    const data = await deps.backend.get('/api/v1/distributions', {
      token: input.token,
      epoch: input.epoch,
    });
    return ok(data);
  } catch (e) {
    return mapBackendError(e);
  }
}

export async function readTokens(
  _input: ReadTokensInput,
  deps: ToolDeps,
): Promise<ToolResult<unknown>> {
  try {
    const data = await deps.backend.get('/api/v1/tokens');
    return ok(data);
  } catch (e) {
    return mapBackendError(e);
  }
}

export async function readAudit(
  input: ReadAuditInput,
  deps: ToolDeps,
): Promise<ToolResult<unknown>> {
  try {
    const data = await deps.backend.get('/api/v1/agent/policy/audit', {
      surface: input.surface,
      eventTypes: input.eventTypes?.join(','),
      since: input.since,
      until: input.until,
      cursor: input.cursor,
      limit: input.limit,
    });
    return ok(data);
  } catch (e) {
    return mapBackendError(e);
  }
}

// ---------- position group ----------

/**
 * 2026-05-18 Option A (Path C): position tools no longer return an
 * unsigned UserOp envelope + broker signature. Instead they return a
 * deep-link URL the LLM relays to the user; the user opens it in their
 * browser, the existing dashboard page (TradePage / CashPage /
 * YieldsPage) loads with the form pre-filled, the user reviews + taps,
 * the existing passkey + ZeroDev kernel flow settles.
 *
 * Why this shape:
 *  - The placeholder-envelope path (`broker signs an intent hash`) was
 *    never actually executable on-chain — the canonical UserOp shape
 *    never landed in P6 as planned, leaving the tools as attestation-
 *    only with no follow-up surface. Operators reasonably reported
 *    "can I buy via MCP or not?" — the honest answer was "no".
 *  - Reusing the dashboard's existing TradePage / CashPage / YieldsPage
 *    means MCP-driven actions go through the SAME passkey ceremony,
 *    SAME slippage previews, SAME post-trade refresh as a user clicking
 *    through the dashboard directly. No new attack surface.
 *  - The broker daemon is no longer required for position tools — they
 *    talk to the backend for token-catalog resolution + URL building
 *    only. Read tools + governance + issuer tools still use the broker
 *    JWT path (auth-required wrapper).
 *
 * Drawback explicitly accepted: MCP cannot programmatically observe
 * settlement. The LLM verifies a buy landed by calling
 * `muhaven.read.portfolio` after the user reports done. Closing the
 * settle-side gap requires Arch-B (ERC-7715 caveated permissions) +
 * an SSE-aware broker — Wave 5.
 */
interface PositionPrefillData {
  /**
   * Absolute deep-link URL the LLM relays to the user. Of shape
   *   `<dashboardBaseUrl>/<page>?<form-prefill-query>&from=mcp`
   * The `from=mcp` flag is reserved for a future audit-attribution UI
   * but does NOT affect the existing page logic today.
   */
  readonly dashboardUrl: string;
  /**
   * Short verb the LLM uses when relaying the URL ("review the buy",
   * "review the redemption", "review the claim", "review the wrap").
   * Pre-built here so the prompt-engineering layer doesn't have to map
   * tool name → verb.
   */
  readonly action: 'buy' | 'sell' | 'claim' | 'wrap';
  /**
   * Two-line, copy-paste-friendly text the LLM can show the user. The
   * MCP server pre-formats this so different hosts render it
   * consistently. Trailing newline preserved by the host's markdown.
   *
   * Example:
   *   "Open this link to review and authorize the buy of 5 mhUSDC of TBILL1:
   *    https://muhaven.app/trade?mode=buy&token=TBILL1&amount=5"
   */
  readonly instructions: string;
  /**
   * Mirror of the input so the LLM can verify the URL it received
   * matches what it asked for (defense against a future backend bug
   * that returns a misrouted URL). Cleartext, not encrypted.
   */
  readonly echo: {
    readonly action: 'buy' | 'sell' | 'claim' | 'wrap';
    readonly token?: string;
    readonly amount?: string;
    readonly shares?: string;
    readonly epoch?: string;
  };
}

/**
 * Build the deep-link URL for a position action. Pure — testable via
 * `buildPositionDeeplink` unit tests without spawning anything.
 *
 * Path parameter (`/trade`, `/cash`, `/yields`) is hardcoded per
 * action because the destination page is a contract of this surface
 * (not the LLM's choice). Query params are URL-encoded via
 * URLSearchParams which handles the `&` / `=` / non-ASCII edge cases.
 *
 * Trailing slash on `dashboardBaseUrl` is tolerated — we trim it so
 * the joined URL never has `//page`.
 */
export function buildPositionDeeplink(
  dashboardBaseUrl: string,
  action: 'buy' | 'sell' | 'claim' | 'wrap',
  params: Record<string, string>,
): string {
  const base = dashboardBaseUrl.replace(/\/+$/, '');
  const path =
    action === 'buy' || action === 'sell'
      ? '/trade'
      : action === 'claim'
        ? '/yields'
        : '/cash';
  const search = new URLSearchParams();
  if (action === 'buy' || action === 'sell') search.set('mode', action);
  for (const [k, v] of Object.entries(params)) search.set(k, v);
  // `from=mcp` reserved for the future "originated by your MCP client"
  // badge on the dashboard pages. Today it's a no-op marker.
  search.set('from', 'mcp');
  return `${base}${path}?${search.toString()}`;
}

// 0.2.0 cleanup: `formatUsdc6ToDecimal` removed — `position.buy.amountUsdc`
// is now a human-decimal input matching `cash.wrap.amountUsdc`, so the
// base-6-to-decimal conversion is unnecessary. Same change deletes the
// `computeIntentHash` / `PLACEHOLDER_INTENT_DOMAIN` / `sortKeys` exports
// that previously served the broker-attestation path (also removed in
// 0.1.7 with the placeholder envelope).

/**
 * Per-process cache of the most recent `hello.hasSessionKey` value. A
 * single broker `hello()` round-trip is enough to detect the read-only
 * posture; we cache the result for the lifetime of the MCP subprocess
 * to avoid an IPC round-trip on every write-path call. The host can
 * always force a refresh by reconnecting the MCP subprocess (one-off
 * cost on Claude Desktop restart).
 *
 * Stored as a `Promise<boolean>` (not a settled `boolean`) so concurrent
 * tool calls during the FIRST probe share the same in-flight hello —
 * otherwise two simultaneous `signEnvelope` callers would each issue
 * their own IPC round-trip + IPC connect. Once resolved, subsequent calls
 * await the already-resolved promise (zero IPC cost).
 *
 * On probe failure (broker down at probe time), the rejected promise is
 * NOT cached — we clear the slot so a later call retries instead of
 * surfacing the same stale rejection forever.
 */
// 0.2.0 cleanup: `__resetSessionKeyProbeCacheForTests` (retained as a
// no-op in 0.1.7 for "back-compat") and `signEnvelope` + the broker
// session-key probe (deleted in 0.1.7 alongside the placeholder UserOp
// envelope) — all gone. Position tools build dashboard deep-link URLs;
// no signing-path code lives here anymore. A future attestation
// surface that wants a domain-separated digest can re-add as needed.

/**
 * Resolve the dashboard base URL from deps. The MCP server is
 * configured at boot with `MUHAVEN_DASHBOARD_URL` (defaulting to
 * `https://muhaven.app` per the setup script env defaults); the host
 * passes it through `dashboardBaseUrl`. Falls back to the prod
 * default for back-compat with hosts that don't set the dep.
 */
function resolveDashboardBaseUrl(deps: ToolDeps): string {
  return deps.dashboardBaseUrl ?? 'https://muhaven.app';
}

export async function positionBuy(
  input: PositionBuyInput,
  deps: ToolDeps,
): Promise<ToolResult<PositionPrefillData>> {
  // 0.2.0: amount is human-decimal mhUSDC directly. Pass-through to URL;
  // schema already validated regex + length. The dashboard's TradePage
  // parses `?amount=` as mhUSDC (matching the form's own convention).
  const dashboardUrl = buildPositionDeeplink(resolveDashboardBaseUrl(deps), 'buy', {
    token: input.token,
    amount: input.amountUsdc,
  });
  return ok({
    dashboardUrl,
    action: 'buy',
    instructions:
      `Open this link to review and authorize the buy of ${input.amountUsdc} mhUSDC of ${input.token}:\n${dashboardUrl}`,
    echo: { action: 'buy', token: input.token, amount: input.amountUsdc },
  });
}

export async function positionSell(
  input: PositionSellInput,
  deps: ToolDeps,
): Promise<ToolResult<PositionPrefillData>> {
  // 0.2.0: schema now enforces positive integer (no fractional shares
  // since fhERC-20 shares are integer base units per
  // `project_decimals_lie_wave4_p0`). Defense-in-depth runtime check
  // dropped — schema is the boundary.
  const dashboardUrl = buildPositionDeeplink(resolveDashboardBaseUrl(deps), 'sell', {
    token: input.token,
    shares: input.amountShares,
  });
  return ok({
    dashboardUrl,
    action: 'sell',
    instructions:
      `Open this link to review and authorize the sale of ${input.amountShares} shares of ${input.token}:\n${dashboardUrl}`,
    echo: { action: 'sell', token: input.token, shares: input.amountShares },
  });
}

export async function positionClaim(
  input: PositionClaimInput,
  deps: ToolDeps,
): Promise<ToolResult<PositionPrefillData>> {
  // `escrowId` is the optional epoch id for the Wave-3.5 YieldSnapshot
  // claim path. When set we deep-link to the specific row + highlight
  // it on the page; when omitted, /yields renders the full claimable
  // list and the user picks. Both paths use the same passkey ceremony.
  const params: Record<string, string> = { token: input.token };
  if (input.escrowId) params.epoch = input.escrowId;
  const dashboardUrl = buildPositionDeeplink(resolveDashboardBaseUrl(deps), 'claim', params);
  const claimDescriptor = input.escrowId
    ? `the claim for epoch #${input.escrowId} of ${input.token}`
    : `your claimable epochs for ${input.token}`;
  return ok({
    dashboardUrl,
    action: 'claim',
    instructions: `Open this link to review and authorize ${claimDescriptor}:\n${dashboardUrl}`,
    echo: {
      action: 'claim',
      token: input.token,
      ...(input.escrowId ? { epoch: input.escrowId } : {}),
    },
  });
}

export async function positionRebalance(
  _input: PositionRebalanceInput,
  _deps: ToolDeps,
): Promise<ToolResult<never>> {
  // Multi-leg rebalance is intentionally NOT mapped to a deep-link in
  // Path C. The dashboard's TradePage handles one leg at a time; a
  // multi-leg rebalance needs `executeBatch` on the kernel + a
  // composite preview UI that doesn't exist yet. Wave 5 ships this as
  // `position.execute_plan(legs[])` against a dedicated rebalance page.
  // For now, surface a clear deferred-feature error so the LLM stops
  // proposing it.
  return err(
    'not_implemented',
    'position.rebalance is deferred to Wave 5. Today, ask the user to execute legs one at a time via position.buy / position.sell, or use the dashboard /trade page directly.',
  );
}

// ---------- cash group ----------
//
// `wrap` (USDC → mhUSDC) is exposed because the most common LLM
// follow-up to a buy proposal is "user has USDC but no mhUSDC". The
// LLM can chain: read.portfolio → notice 0 mhUSDC → cash.wrap → then
// position.buy. Each step is a deep-link the user reviews + signs.
//
// `unwrap` (mhUSDC → USDC) intentionally NOT exposed in v0.1.7 —
// there's no working unwrap surface in the dashboard today (CashPage
// is wrap-only). When the page lands the tool can be added in one
// edit here without an architecture change.

export async function cashWrap(
  input: import('./schemas.js').CashWrapInput,
  deps: ToolDeps,
): Promise<ToolResult<PositionPrefillData>> {
  // `amountUsdc` is human-readable USDC (e.g. "100" for $100). Per the
  // schema validation upstream, this is already a positive decimal
  // string — pass through to the URL verbatim. The dashboard's
  // CashPage form parses `?amount=` as USDC base-1 units (not 1e-6).
  const dashboardUrl = buildPositionDeeplink(resolveDashboardBaseUrl(deps), 'wrap', {
    amount: input.amountUsdc,
  });
  return ok({
    dashboardUrl,
    action: 'wrap',
    instructions:
      `Open this link to review and authorize the conversion of ${input.amountUsdc} USDC into mhUSDC:\n${dashboardUrl}`,
    echo: { action: 'wrap', amount: input.amountUsdc },
  });
}

// ---------- policy group ----------

export async function policySetTier(
  input: PolicySetTierInput,
  deps: ToolDeps,
): Promise<ToolResult<unknown>> {
  try {
    const data = await deps.backend.post('/api/v1/agent/policy/transition', {
      surface: deps.surface,
      targetTier: input.targetTier,
      ...(input.confirmationToken ? { confirmationToken: input.confirmationToken } : {}),
    });
    return ok(data);
  } catch (e) {
    return mapBackendError(e);
  }
}

export async function policyPause(
  input: PolicyPauseInput,
  deps: ToolDeps,
): Promise<ToolResult<unknown>> {
  try {
    const data = await deps.backend.post('/api/v1/agent/policy/pause', {
      ...(input.surface ? { surface: input.surface } : {}),
    });
    return ok({
      backend: data,
      onChain: {
        action: 'uninstallPlugin',
        note: 'Submit via dashboard passkey or follow-up muhaven.position.* invocation.',
      },
    });
  } catch (e) {
    return mapBackendError(e);
  }
}

export async function policyAuditExport(
  input: PolicyAuditExportInput,
  deps: ToolDeps,
): Promise<ToolResult<unknown>> {
  // Drains the cursor in a loop with a hard `maxRows` cap so a malformed
  // backend cannot trick us into unbounded paging.
  const items: unknown[] = [];
  let cursor: string | undefined = undefined;
  let pages = 0;
  const PAGE_LIMIT = 200;
  const MAX_PAGES = Math.ceil(input.maxRows / PAGE_LIMIT) + 1;

  try {
    while (items.length < input.maxRows && pages < MAX_PAGES) {
      const page = (await deps.backend.get('/api/v1/agent/policy/audit', {
        surface: input.surface,
        since: input.since,
        until: input.until,
        cursor,
        limit: PAGE_LIMIT,
      })) as { items?: unknown[]; cursor?: string };

      const got = Array.isArray(page.items) ? page.items : [];
      for (const row of got) {
        if (items.length >= input.maxRows) break;
        items.push(row);
      }
      pages++;
      if (!page.cursor || got.length === 0) break;
      cursor = page.cursor;
    }
    return ok({ items, total: items.length, truncated: items.length === input.maxRows });
  } catch (e) {
    return mapBackendError(e);
  }
}

export async function policySessionKeyStatus(
  _input: PolicySessionKeyStatusInput,
  deps: ToolDeps,
): Promise<ToolResult<unknown>> {
  try {
    const data = await deps.backend.get('/api/v1/agent/policy/state', { surface: deps.surface });
    return ok(data);
  } catch (e) {
    return mapBackendError(e);
  }
}

// ---------- issuer group (Wave 4 P7) ----------
//
// All issuer tools are thin proxies over the existing HavenBot
// `/agent/tools/propose_*` routes. The backend's ToolDispatcher fans out
// to the same use-cases regardless of surface, so the MCP host gets the
// same ActionDescriptor shape that HavenBot returns. The issuer kernel
// (the user's existing JWT subject) is the actual signer — the broker
// daemon does NOT auto-submit; the host LLM presents the descriptor for
// host-side confirmation.

export async function issuerDistributeYield(
  input: IssuerDistributeYieldInput,
  deps: ToolDeps,
): Promise<ToolResult<unknown>> {
  try {
    const data = await deps.backend.post('/api/v1/agent/tools/propose_distribute_yield', {
      tokenAddress: input.tokenAddress,
      totalYieldUsd6: input.totalYieldUsd6,
      ...(input.label ? { label: input.label } : {}),
    });
    return ok(data);
  } catch (e) {
    return mapBackendError(e);
  }
}

export async function issuerKycAdd(
  input: IssuerKycAddInput,
  deps: ToolDeps,
): Promise<ToolResult<unknown>> {
  try {
    const data = await deps.backend.post('/api/v1/agent/tools/propose_kyc_add', {
      tokenAddress: input.tokenAddress,
      investorAddress: input.investorAddress,
      kycTier: input.kycTier,
    });
    return ok(data);
  } catch (e) {
    return mapBackendError(e);
  }
}

export async function issuerKycRemove(
  input: IssuerKycRemoveInput,
  deps: ToolDeps,
): Promise<ToolResult<unknown>> {
  try {
    const data = await deps.backend.post('/api/v1/agent/tools/propose_kyc_remove', {
      tokenAddress: input.tokenAddress,
      investorAddress: input.investorAddress,
    });
    return ok(data);
  } catch (e) {
    return mapBackendError(e);
  }
}

export async function issuerUnpauseToken(
  input: IssuerUnpauseTokenInput,
  deps: ToolDeps,
): Promise<ToolResult<unknown>> {
  try {
    const data = await deps.backend.post('/api/v1/agent/tools/propose_unpause_token', {
      tokenAddress: input.tokenAddress,
      initialNavUsd6: input.initialNavUsd6,
    });
    return ok(data);
  } catch (e) {
    return mapBackendError(e);
  }
}

export async function issuerAuditQuery(
  input: IssuerAuditQueryInput,
  deps: ToolDeps,
): Promise<ToolResult<unknown>> {
  try {
    const data = await deps.backend.get('/api/v1/agent/tools/audit_query', {
      surface: input.surface,
      eventTypes: input.eventTypes?.join(','),
      since: input.since,
      until: input.until,
      cursor: input.cursor,
      limit: input.limit,
    });
    return ok(data);
  } catch (e) {
    return mapBackendError(e);
  }
}

// ---------- governance / protection / KYC group (Wave 4 P11) ----------

export async function readProtectionCoverage(
  input: ReadProtectionCoverageInput,
  deps: ToolDeps,
): Promise<ToolResult<unknown>> {
  try {
    const data = await deps.backend.post('/api/v1/agent/tools/check_protection_coverage', {
      tokenAddress: input.tokenAddress,
    });
    return ok(data);
  } catch (e) {
    return mapBackendError(e);
  }
}

export async function readKycAttestation(
  input: ReadKycAttestationInput,
  deps: ToolDeps,
): Promise<ToolResult<unknown>> {
  try {
    const data = await deps.backend.post('/api/v1/agent/tools/explain_kyc_attestation', {
      ...(input.investorAddress ? { investorAddress: input.investorAddress } : {}),
    });
    return ok(data);
  } catch (e) {
    return mapBackendError(e);
  }
}

export async function governancePropose(
  input: GovernanceProposeInput,
  deps: ToolDeps,
): Promise<ToolResult<unknown>> {
  try {
    const data = await deps.backend.post('/api/v1/agent/tools/propose_governance_vote', {
      tokenAddress: input.tokenAddress,
      proposalType: input.proposalType,
    });
    return ok(data);
  } catch (e) {
    return mapBackendError(e);
  }
}

export async function governanceCastVote(
  input: GovernanceCastVoteInput,
  deps: ToolDeps,
): Promise<ToolResult<unknown>> {
  try {
    const data = await deps.backend.post('/api/v1/agent/tools/cast_encrypted_vote', {
      proposalId: input.proposalId,
      voteYes: input.voteYes,
    });
    return ok(data);
  } catch (e) {
    return mapBackendError(e);
  }
}
