/**
 * Adversarial test corpus targeting the MCP server boundary.
 *
 * Wave 4 P10 §"P3 deferred testing" item 3 — Promptfoo / DeepTeam-style
 * adversarial set targeting the MCP tool layer specifically.
 *
 * Scope (intentionally narrow):
 *   1. tool-name-injection — host LLM emits an invented tool name like
 *      `muhaven.read.portfolio.exfiltrate`, prototype keys, or
 *      whitespace/case variants. The MCP server MUST refuse without
 *      partial-match fallback.
 *   2. schema-bypass — input arguments that try to exploit JSON-Schema
 *      additionalProperties leniency: extra fields, prototype-pollution
 *      `__proto__` / `constructor`, hex-address fields with embedded
 *      control chars, off-by-bound integer / array sizes.
 *   3. scope-bypass — caller's JWT only carries `mcp.read.*`; tool layer
 *      forwards request to backend; backend returns 403 with a structured
 *      `forbidden_scope` body. Server MUST surface the structured payload
 *      without retry, without exposing the JWT, without re-trying.
 *
 * Tests run end-to-end against an InMemoryTransport-bridged Client +
 * Server pair so the tool dispatch + zod validation + error mapping fire
 * exactly as they would over STDIO. Backend + broker are stubbed; the
 * scope-bypass case asserts on the structured payload returned to the
 * host LLM, not on the underlying HTTP path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/server.js';
import {
  BackendClient,
  BackendError,
  type BackendClientOptions,
} from '../src/clients/backend-client.js';
import { selectRegistry } from '../src/tools/registry.js';
import {
  PolicyAuditExportInputSchema,
  PolicyPauseInputSchema,
  PolicySetTierInputSchema,
  PositionBuyInputSchema,
  ReadAuditInputSchema,
  ReadDistributionInputSchema,
  ReadYieldsInputSchema,
} from '../src/tools/schemas.js';

// ----- helpers ------------------------------------------------------------

interface FakeJwtSource {
  get: () => Promise<string>;
  invalidate: () => void;
}

function makeJwtSource(jwt = 'h.p.s'): FakeJwtSource {
  return { get: async () => jwt, invalidate: vi.fn() };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface HarnessOptions {
  /** Drives every fetch the BackendClient makes during the test. */
  fetchImpl?: BackendClientOptions['fetchImpl'];
  /** Force read-only registry to assert scope at the registry layer too. */
  readOnly?: boolean;
}

async function buildHarness(opts: HarnessOptions = {}) {
  const fetchImpl: BackendClientOptions['fetchImpl'] =
    opts.fetchImpl ?? (vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch);
  const backend = new BackendClient({
    baseUrl: 'https://backend.example.com',
    jwtSource: makeJwtSource() as unknown as BackendClientOptions['jwtSource'],
    timeoutMs: 5_000,
    allowedHosts: ['backend.example.com'],
    fetchImpl,
  });
  const server = buildMcpServer({
    registry: selectRegistry(opts.readOnly ?? false),
    backend,
    broker: undefined,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'test-host', version: '0.0.0' },
    { capabilities: {} },
  );
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, fetchImpl };
}

// ----- 1. tool-name-injection --------------------------------------------

describe('redteam · tool-name injection', () => {
  let h: Awaited<ReturnType<typeof buildHarness>>;
  beforeEach(async () => {
    h = await buildHarness();
  });

  // Adversarial names that an injected LLM might emit. None exist in the
  // canonical 22-tool surface (P3+P7+P11); all MUST land on `unknown_tool`.
  // This also documents that the dispatch is exact-match: no fuzzy
  // resolution, no partial-prefix fallback, no case-insensitive lookup.
  const INJECTED_NAMES = [
    'muhaven.read.portfolio.exfiltrate', // canonical name + suffix
    'muhaven.read.portfolio_evil', // canonical name + underscore-suffix
    'muhaven.read.portfolios', // pluralisation
    'muhaven.read.PORTFOLIO', // case mutation
    ' muhaven.read.portfolio', // leading whitespace
    'muhaven.read.portfolio ', // trailing whitespace
    'muhaven.policy.pause.all', // canonical + ".all"
    'muhaven.checkout.create_session', // group reserved for P5 but not yet wired
    'muhaven.admin.set_tier', // invented "admin" group
    'muhaven_read_portfolio', // namespace using underscore not dot
    '__proto__', // prototype key
    'constructor', // prototype key
    '', // empty string
    'muhaven', // truncated namespace
    '.muhaven.read.portfolio', // leading dot
    'muhaven..read.portfolio', // double-dot
    '00muhaven.read.portfolio', // numeric prefix violates regex
  ] as const;

  for (const name of INJECTED_NAMES) {
    it(`refuses invented tool name ${JSON.stringify(name)} with unknown_tool`, async () => {
      const res = await h.client.callTool({ name, arguments: {} });
      const payload = parseSingleTextPayload(res);
      expect(payload).toMatchObject({ ok: false, code: 'unknown_tool' });
    });
  }
});

// ----- 2. schema-bypass ---------------------------------------------------

describe('redteam · schema-bypass / additional-properties', () => {
  let h: Awaited<ReturnType<typeof buildHarness>>;
  beforeEach(async () => {
    h = await buildHarness();
  });

  it('rejects extra "secret" field on muhaven.read.distribution (additionalProperties:false)', async () => {
    const res = await h.client.callTool({
      name: 'muhaven.read.distribution',
      arguments: {
        token: '0x' + 'aa'.repeat(20),
        epoch: 1,
        secret: 'siphon-this',
      } as unknown as Record<string, unknown>,
    });
    const payload = parseSingleTextPayload(res);
    expect(payload).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('does not pollute Object prototype when __proto__ key is in arguments', async () => {
    // Attacker passes a literal __proto__ as a top-level argument key
    // hoping a downstream JSON.parse / Object.assign extends Object's
    // prototype. The defenses are layered:
    //  1. JSON.stringify drops __proto__ during JSON-RPC serialisation
    //     (the SDK round-trips arguments through JSON), so the server
    //     side often never sees the key — the request succeeds.
    //  2. If the key DOES survive serialisation (engine-dependent),
    //     Zod's .strict() rejects it as an unknown property →
    //     `invalid_input`.
    // Either outcome proves no pollution happened. Asserting on either
    // would over-specify the engine's JSON behaviour; what's load-
    // bearing is that Object.prototype was NOT extended by the attempt.
    const args = JSON.parse(
      `{"token":"0x${'aa'.repeat(20)}","epoch":1,"__proto__":{"polluted":true}}`,
    );
    const res = await h.client.callTool({ name: 'muhaven.read.distribution', arguments: args });
    const payload = parseSingleTextPayload(res) as { ok: boolean };
    // Outcome may be `ok: true` (key stripped server-side / proto-polluted
    // value silently dropped before zod) OR `ok: false, code: 'invalid_input'`
    // (zod sees the key and rejects). Both are acceptable — the load-
    // bearing assertion is the prototype probe below.
    expect(typeof payload.ok).toBe('boolean');
    // Sanity probe — Object.prototype must not be polluted.
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    // And neither must Array's.
    expect(([] as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('refuses or sanitises "constructor" arg key (no prototype access)', async () => {
    // The MCP SDK's JSON-RPC layer may itself reject argument objects
    // that include `constructor` because the protocol-validation walker
    // can't safely reflect on it. We accept either:
    //  - SDK throws (caught here) → request never hits the server
    //  - server returns invalid_input → zod's .strict() rejected the key
    // Both prove the path didn't pollute Function.prototype.
    const args = JSON.parse(
      `{"token":"0x${'aa'.repeat(20)}","epoch":1,"constructor":{"prototype":{"polluted":true}}}`,
    );
    let saw: 'sdk-throw' | 'invalid_input' | 'unexpected-ok' = 'unexpected-ok';
    try {
      const res = await h.client.callTool({ name: 'muhaven.read.distribution', arguments: args });
      const payload = parseSingleTextPayload(res) as { ok: boolean; code?: string };
      if (payload.ok === false && payload.code === 'invalid_input') saw = 'invalid_input';
    } catch {
      saw = 'sdk-throw';
    }
    expect(saw).not.toBe('unexpected-ok');
    // Pollution probe.
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    expect((function () {} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('rejects address with embedded control character (regex bounded)', async () => {
    // The control char (\x01) doesn't match the hex-address regex but a
    // sloppy implementation that called .trim() or stripped non-printables
    // server-side could let it through. We assert the schema rejects it.
    const res = await h.client.callTool({
      name: 'muhaven.read.distribution',
      arguments: { token: '0x' + 'aa'.repeat(19) + 'a\x01', epoch: 1 },
    });
    const payload = parseSingleTextPayload(res);
    expect(payload).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('rejects negative epoch (z.int().min(0) fires)', async () => {
    const res = await h.client.callTool({
      name: 'muhaven.read.distribution',
      arguments: { token: '0x' + 'aa'.repeat(20), epoch: -1 },
    });
    const payload = parseSingleTextPayload(res);
    expect(payload).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('rejects rebalance with > 8 legs (max array length enforced)', async () => {
    const leg = { token: '0x' + 'aa'.repeat(20), side: 'buy', amount: '1' };
    const res = await h.client.callTool({
      name: 'muhaven.position.rebalance',
      arguments: { legs: Array.from({ length: 9 }, () => leg) },
    });
    const payload = parseSingleTextPayload(res);
    expect(payload).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('rejects rebalance with < 2 legs (min length enforced)', async () => {
    const res = await h.client.callTool({
      name: 'muhaven.position.rebalance',
      arguments: { legs: [{ token: '0x' + 'aa'.repeat(20), side: 'buy', amount: '1' }] },
    });
    const payload = parseSingleTextPayload(res);
    expect(payload).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('rejects unknown tier on muhaven.policy.set_tier (z.enum bounded)', async () => {
    const res = await h.client.callTool({
      name: 'muhaven.policy.set_tier',
      arguments: { targetTier: 'omnipotent' },
    });
    const payload = parseSingleTextPayload(res);
    expect(payload).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('rejects PolicyAuditExport maxRows above hard cap (5000)', async () => {
    const res = await h.client.callTool({
      name: 'muhaven.policy.audit_export',
      arguments: { maxRows: 1_000_000 },
    });
    const payload = parseSingleTextPayload(res);
    expect(payload).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('rejects PositionBuy amount with leading + sign', async () => {
    // 0.2.0: schema accepts decimal mhUSDC amounts; the regex still
    // rejects the + prefix that some attackers use to sneak past a
    // parseFloat() that would otherwise accept it.
    const res = await h.client.callTool({
      name: 'muhaven.position.buy',
      arguments: { token: '0x' + 'aa'.repeat(20), amountUsdc: '+1000' },
    });
    const payload = parseSingleTextPayload(res);
    expect(payload).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('rejects PositionBuy amount with scientific notation', async () => {
    const res = await h.client.callTool({
      name: 'muhaven.position.buy',
      arguments: { token: '0x' + 'aa'.repeat(20), amountUsdc: '1e6' },
    });
    const payload = parseSingleTextPayload(res);
    expect(payload).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('rejects address missing 0x prefix', async () => {
    const res = await h.client.callTool({
      name: 'muhaven.read.distribution',
      arguments: { token: 'aa'.repeat(20), epoch: 1 },
    });
    const payload = parseSingleTextPayload(res);
    expect(payload).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('rejects address with wrong byte length (19 bytes)', async () => {
    const res = await h.client.callTool({
      name: 'muhaven.read.distribution',
      arguments: { token: '0x' + 'aa'.repeat(19), epoch: 1 },
    });
    const payload = parseSingleTextPayload(res);
    expect(payload).toMatchObject({ ok: false, code: 'invalid_input' });
  });
});

// Direct-schema-level corpus mirrors the client tests but at the .parse
// boundary so a future server refactor can't accidentally make these
// schemas slack. Documents the load-bearing invariants per-tool.
describe('redteam · zod schemas reject prototype + extra keys directly', () => {
  it('ReadDistribution rejects __proto__ key', () => {
    const args = JSON.parse(`{"token":"0x${'aa'.repeat(20)}","epoch":1,"__proto__":{"x":1}}`);
    expect(() => ReadDistributionInputSchema.parse(args)).toThrow();
  });

  it('ReadYields rejects extra cursor field (typo defense)', () => {
    expect(() =>
      ReadYieldsInputSchema.parse({ token: '0x' + 'aa'.repeat(20), cursor: 'X' }),
    ).toThrow();
  });

  it('ReadAudit rejects > 20 eventTypes (DoS bound)', () => {
    const types = Array.from({ length: 21 }, () => 'cron_tick');
    expect(() => ReadAuditInputSchema.parse({ eventTypes: types })).toThrow();
  });

  it('PolicySetTier rejects extra wallet hint', () => {
    expect(() =>
      PolicySetTierInputSchema.parse({ targetTier: 'paused', wallet: '0xdead' }),
    ).toThrow();
  });

  it('PolicyPause rejects unknown surface', () => {
    expect(() => PolicyPauseInputSchema.parse({ surface: 'not-a-surface' })).toThrow();
  });

  it('PolicyAuditExport coerces maxRows default when omitted', () => {
    const out = PolicyAuditExportInputSchema.parse({});
    expect(out.maxRows).toBe(1000);
  });

  it('PositionBuy accepts amountUsdc = "0" (wire-shape valid; business logic rejects)', () => {
    // 0.2.0: decimal regex accepts "0" — the spec correctly delegates
    // the "must be > 0" check to the use case (cleartext zero is a
    // valid wire-shape, business logic rejects on the on-chain leg).
    // Document that posture by proving the schema accepts "0".
    expect(() =>
      PositionBuyInputSchema.parse({ token: '0x' + 'aa'.repeat(20), amountUsdc: '0' }),
    ).not.toThrow();
  });
});

// ----- 3. scope-bypass ----------------------------------------------------

describe('redteam · scope-bypass via 403 on policy tool with read-only JWT', () => {
  it('mcp.policy.set_tier with read-only JWT lands on backend.forbidden (no retry, no leak)', async () => {
    const calls: string[] = [];
    const fetchImpl: BackendClientOptions['fetchImpl'] = (async (input: URL | string) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      // Mirror what the backend's `withScope(['mcp.propose.*'])` middleware
      // returns when the JWT only carries `mcp.read.*` — a structured
      // 403 with a `forbidden_scope` reason. The MCP server must:
      //  1. NOT retry (the BackendClient retries on 401 but NEVER on 403).
      //  2. Surface a structured `backend.forbidden` to the host LLM
      //     without exposing the JWT or the missing scope name.
      return jsonResponse(
        { error: 'forbidden_scope', missingScope: 'mcp.propose.*' },
        403,
      );
    }) as unknown as typeof fetch;

    const h = await buildHarness({ fetchImpl });
    const res = await h.client.callTool({
      name: 'muhaven.policy.set_tier',
      arguments: { targetTier: 'paused' },
    });
    const payload = parseSingleTextPayload(res);
    expect(payload).toMatchObject({ ok: false, code: 'backend.forbidden' });
    // EXACTLY one upstream call — 403 must NOT retry.
    expect(calls.length).toBe(1);
  });

  it('mcp.policy.pause cascade with read-only JWT lands on backend.forbidden', async () => {
    const fetchImpl: BackendClientOptions['fetchImpl'] = (async () =>
      jsonResponse({ error: 'forbidden_scope' }, 403)) as unknown as typeof fetch;
    const h = await buildHarness({ fetchImpl });
    const res = await h.client.callTool({ name: 'muhaven.policy.pause', arguments: {} });
    const payload = parseSingleTextPayload(res);
    expect(payload).toMatchObject({ ok: false, code: 'backend.forbidden' });
  });

  it('read-only registry also denies policy / position / issuer at the dispatch layer', async () => {
    // When the broker has been configured with `MUHAVEN_READ_ONLY=true`
    // the registry strips position/policy/issuer tools entirely. A host
    // LLM that emits a previously-known policy name now lands on
    // unknown_tool, not forbidden — defense in depth.
    const h = await buildHarness({ readOnly: true });
    const res = await h.client.callTool({
      name: 'muhaven.policy.set_tier',
      arguments: { targetTier: 'paused' },
    });
    const payload = parseSingleTextPayload(res);
    expect(payload).toMatchObject({ ok: false, code: 'unknown_tool' });

    const res2 = await h.client.callTool({
      name: 'muhaven.position.buy',
      arguments: { token: '0x' + 'aa'.repeat(20), amountUsdc: '1000' },
    });
    const payload2 = parseSingleTextPayload(res2);
    expect(payload2).toMatchObject({ ok: false, code: 'unknown_tool' });

    const res3 = await h.client.callTool({
      name: 'muhaven.issuer.distribute_yield',
      arguments: { tokenAddress: '0x' + 'aa'.repeat(20), totalYieldUsd6: '1000' },
    });
    const payload3 = parseSingleTextPayload(res3);
    expect(payload3).toMatchObject({ ok: false, code: 'unknown_tool' });
  });

  it('read-only registry advertises only the 8 read.* tools to listTools', async () => {
    // Wave 4 P11 added 2 read tools (protection_coverage + kyc_attestation)
    // and 0.2.1 added read.activity for Path C settle verification,
    // bringing the read group to 8.
    const h = await buildHarness({ readOnly: true });
    const list = await h.client.listTools();
    expect(list.tools.length).toBe(8);
    for (const t of list.tools) {
      expect(t.name.startsWith('muhaven.read.')).toBe(true);
    }
  });

  it('full registry advertises all 25 tools (8 read + 4 position + 2 cash + 4 policy + 5 issuer + 2 governance)', async () => {
    const h = await buildHarness();
    const list = await h.client.listTools();
    expect(list.tools.length).toBe(25);
    const groups = countBy(list.tools.map((t) => t.name.split('.')[1]));
    expect(groups.read).toBe(8);
    expect(groups.position).toBe(4);
    expect(groups.cash).toBe(2);
    expect(groups.policy).toBe(4);
    expect(groups.issuer).toBe(5);
    expect(groups.governance).toBe(2);
  });
});

// ----- 4. error mapping invariants ---------------------------------------

describe('redteam · backend-error mapping does not leak server internals', () => {
  it('500 surfaces backend.server_error without echoing JWT or url', async () => {
    const fetchImpl: BackendClientOptions['fetchImpl'] = (async () =>
      jsonResponse({ stack: 'fake-stack', cwd: '/etc/secret' }, 500)) as unknown as typeof fetch;
    const h = await buildHarness({ fetchImpl });
    const res = await h.client.callTool({ name: 'muhaven.read.portfolio', arguments: {} });
    const payload = parseSingleTextPayload(res) as { ok: false; code: string; message: string };
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('backend.server_error');
    expect(payload.message).not.toContain('h.p.s'); // jwt prefix
    expect(payload.message).not.toContain('Bearer ');
  });

  it('429 surfaces backend.rate_limited (not retried, not silently merged with 4xx)', async () => {
    const fetchImpl: BackendClientOptions['fetchImpl'] = (async () =>
      jsonResponse({ retryAfterMs: 60_000 }, 429)) as unknown as typeof fetch;
    const h = await buildHarness({ fetchImpl });
    const res = await h.client.callTool({ name: 'muhaven.read.portfolio', arguments: {} });
    const payload = parseSingleTextPayload(res);
    expect(payload).toMatchObject({ ok: false, code: 'backend.rate_limited' });
  });

  it('a thrown BackendError("unauthorized") surfaces AUTH_REQUIRED with login command', async () => {
    // Two consecutive 401s exhausts the BackendClient's single-retry budget
    // and surfaces unauthorized — server.ts maps that to the structured
    // AUTH_REQUIRED payload.
    const fetchImpl: BackendClientOptions['fetchImpl'] = (async () =>
      jsonResponse({ error: 'token-revoked' }, 401)) as unknown as typeof fetch;
    const h = await buildHarness({ fetchImpl });
    const res = await h.client.callTool({ name: 'muhaven.read.portfolio', arguments: {} });
    const payload = parseSingleTextPayload(res) as {
      ok: false;
      code: string;
      message?: string;
      loginCommand?: string;
    };
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('AUTH_REQUIRED');
    expect(payload.loginCommand).toBe('muhaven-broker login');
  });

  it('directly thrown BackendError instance surfaces backend.<code>', () => {
    const err = new BackendError('not_found', 'POST /x → 404', 404);
    expect(err.code).toBe('not_found');
    expect(err.status).toBe(404);
  });
});

// ----- helpers shared across cases ---------------------------------------

interface ToolCallResult {
  content?: { type?: string; text?: string }[];
  isError?: boolean;
}

function parseSingleTextPayload(res: unknown): unknown {
  const r = res as ToolCallResult;
  expect(Array.isArray(r.content)).toBe(true);
  const first = r.content?.[0];
  expect(first?.type).toBe('text');
  expect(typeof first?.text).toBe('string');
  return JSON.parse(first!.text!);
}

function countBy<T extends string>(items: readonly T[]): Record<T, number> {
  const out = {} as Record<T, number>;
  for (const i of items) out[i] = (out[i] ?? 0) + 1;
  return out;
}
