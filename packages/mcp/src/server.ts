/**
 * MCP STDIO server bridge — registers all tools from `tools/registry.ts`
 * with `@modelcontextprotocol/sdk`'s STDIO transport, validates each
 * tool input against its zod schema, and dispatches to the handler.
 *
 * Hardening invariants per `THREAT_MODEL_P0.md` + ADR-3:
 *  - Transport is STDIO **only** — never TCP. The MCP SDK's
 *    `StdioServerTransport` is the only one we mount.
 *  - Tool inputs are zod-validated server-side; the LLM cannot inject
 *    new fields (`additionalProperties: false`).
 *  - Tool descriptions are pinned at build time via `tool-hashes.json`
 *    and re-verified on startup. A drift exits with code 70 (matches
 *    the BSD `EX_CONFIG` convention).
 *  - On any backend `unauthorized` response after a single retry, the
 *    handler returns a structured `AUTH_REQUIRED` payload that
 *    instructs the user to run `muhaven-broker login`.
 */

import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ZodError } from 'zod';
import { loadMcpConfig } from './config.js';
import { JwtSource, NoJwtAvailableError } from './auth/jwt-source.js';
import { BackendClient, BackendError } from './clients/backend-client.js';
import { BrokerClient, BrokerClientError } from './clients/broker-client.js';
import { BundlerClient } from './clients/bundler-client.js';
import { selectRegistry, type ToolEntry } from './tools/registry.js';
import {
  TOOL_DESCRIPTORS,
  hashToolDescriptor,
  type ToolHashEntry,
} from './tools/descriptions.js';

import { authRequiredPayload } from './tools/auth-required.js';

// `__SERVER_VERSION__` is replaced by tsup at build time (see tsup.config.ts
// `define` block — sourced from `package.json#version`, single source of
// truth). When the module is imported unbundled (vitest), the constant is
// undefined; fall back to the runtime require of the sibling package.json.
declare const __SERVER_VERSION__: string | undefined;

const SERVER_NAME = '@muhaven/mcp';
export const SERVER_VERSION = resolveServerVersion();

function resolveServerVersion(): string {
  if (typeof __SERVER_VERSION__ === 'string' && __SERVER_VERSION__) {
    return __SERVER_VERSION__;
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // Vitest path: src/server.ts → ../package.json
    const candidates = [
      join(here, '..', 'package.json'),
      // Compiled-fallback path: dist/index.cjs → ../package.json
      join(here, '..', '..', 'package.json'),
    ];
    for (const path of candidates) {
      try {
        const raw = readFileSync(path, 'utf-8');
        const pkg = JSON.parse(raw) as { version?: unknown; name?: unknown };
        if (typeof pkg.version === 'string' && pkg.name === SERVER_NAME) {
          return pkg.version;
        }
      } catch {
        // try next
      }
    }
  } catch {
    // fall through to placeholder
  }
  return '0.0.0-dev';
}

interface ZodSchemaWithJsonSchema {
  parse(input: unknown): unknown;
}

function toJsonInputSchema(schema: ZodSchemaWithJsonSchema): Record<string, unknown> {
  // Avoid a runtime dep on `zod-to-json-schema` for hackathon scope. We
  // ship the input zod's `.parse(...)` for actual validation; the
  // host-facing JSON schema is "object, additional properties not
  // allowed" — accurate (every schema is `.strict()`) without being
  // exhaustive about field-by-field shape.
  void schema;
  return {
    type: 'object',
    additionalProperties: false,
  };
}

async function loadPinnedToolHashes(): Promise<readonly ToolHashEntry[] | null> {
  // Resolve relative to this file regardless of cjs/esm bundle layout.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'tool-hashes.json'),
    join(here, 'tool-hashes.json'),
  ];
  for (const path of candidates) {
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.tools)) return parsed.tools as ToolHashEntry[];
    } catch {
      // try next
    }
  }
  return null;
}

function verifyToolHashes(pinned: readonly ToolHashEntry[] | null): {
  ok: boolean;
  drift: { name: string; live: string; pinned: string }[];
} {
  if (!pinned) return { ok: true, drift: [] };
  const pinnedMap = new Map(pinned.map((p) => [p.name, p.sha256]));
  const drift: { name: string; live: string; pinned: string }[] = [];
  for (const t of TOOL_DESCRIPTORS) {
    const live = hashToolDescriptor(t);
    const pin = pinnedMap.get(t.name);
    if (!pin || pin !== live) {
      drift.push({ name: t.name, live, pinned: pin ?? '<missing>' });
    }
  }
  return { ok: drift.length === 0, drift };
}

export interface BuildServerOptions {
  registry: readonly ToolEntry[];
  backend: BackendClient;
  broker: BrokerClient | undefined;
  /**
   * Wave 5 Path D Slice 1 (Commit 3) — bundler client wired through to
   * `ToolDeps.bundler`. Undefined → Path D autonomous mode off; position
   * tools stay on Path C deep-link (existing behaviour). Configured from
   * `MUHAVEN_BUNDLER_URL` env at MCP boot.
   */
  bundler?: BundlerClient;
  /**
   * Threaded into `ToolDeps` so the `SESSION_KEY_REQUIRED` payload's
   * `mintUrl` points at the operator's actual dashboard, not a hardcoded
   * production URL.
   */
  dashboardBaseUrl?: string;
}

export function buildMcpServer(opts: BuildServerOptions): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: opts.registry.map((entry) => ({
        name: entry.descriptor.name,
        description: entry.descriptor.description,
        inputSchema: toJsonInputSchema(entry.schema as ZodSchemaWithJsonSchema),
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const entry = opts.registry.find((e) => e.descriptor.name === name);
    if (!entry) {
      return toolJsonResponse({ ok: false, code: 'unknown_tool', message: `unknown tool: ${name}` });
    }
    let parsed: unknown;
    try {
      parsed = entry.schema.parse(req.params.arguments ?? {});
    } catch (err) {
      if (err instanceof ZodError) {
        return toolJsonResponse({
          ok: false,
          code: 'invalid_input',
          message: 'tool input failed schema validation',
          issues: err.issues,
        });
      }
      throw err;
    }
    try {
      const result = await entry.handler(parsed, {
        backend: opts.backend,
        broker: opts.broker,
        bundler: opts.bundler,
        surface: 'mcp',
        dashboardBaseUrl: opts.dashboardBaseUrl,
      });
      return toolJsonResponse(result);
    } catch (err) {
      if (err instanceof NoJwtAvailableError) {
        return toolJsonResponse(authRequiredPayload());
      }
      if (err instanceof BackendError && err.code === 'unauthorized') {
        return toolJsonResponse(authRequiredPayload());
      }
      if (err instanceof BackendError) {
        return toolJsonResponse({ ok: false, code: `backend.${err.code}`, message: err.message });
      }
      if (err instanceof BrokerClientError) {
        return toolJsonResponse({ ok: false, code: `broker.${err.code}`, message: err.message });
      }
      return toolJsonResponse({
        ok: false,
        code: 'internal',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return server;
}

function toolJsonResponse(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

/**
 * Boot options for `runMcpStdioCli`.
 *
 * `filterRegistry` is the OpenClaw-shaped extension point: callers can
 * supply a function that receives the post-`--read-only` registry and
 * returns a (possibly narrower) subset. The bundled OpenClaw skill uses
 * this to ship a curated 11-tool subset out of the 22-tool upstream
 * surface (ADR-C). The filter MUST be a pure function; any side effect
 * (mutation of the input array, network call, etc.) is unsupported.
 *
 * Tool-description hash verification fires BEFORE the filter — drift in
 * an upstream descriptor must abort startup even if the consumer would
 * have filtered the affected tool out. Otherwise an attacker who patches
 * a single descriptor could hide it from the verification gate by
 * shipping a subset filter that excludes only that tool.
 */
export interface RunMcpStdioCliOptions {
  filterRegistry?: (registry: readonly ToolEntry[]) => readonly ToolEntry[];
}

/** Production STDIO entrypoint — wired through `bin/muhaven-mcp.cjs`. */
export async function runMcpStdioCli(opts: RunMcpStdioCliOptions = {}): Promise<void> {
  const config = loadMcpConfig();

  const pinned = await loadPinnedToolHashes();
  const verify = verifyToolHashes(pinned);
  if (!verify.ok) {
    process.stderr.write(
      'tool-description hash drift detected — refusing to start. drift:\n' +
        JSON.stringify(verify.drift, null, 2) +
        '\n',
    );
    process.exit(70);
  }

  const broker = new BrokerClient({
    endpoint: config.brokerEndpoint,
    timeoutMs: config.brokerTimeoutMs,
  });
  const jwtSource = new JwtSource(broker, config.jwtCacheTtlSec);
  const backend = new BackendClient({
    baseUrl: config.backendBaseUrl,
    jwtSource,
    timeoutMs: config.requestTimeoutMs,
    allowedHosts: config.allowedBackendHosts,
  });
  // Wave 5 Path D Slice 1 (Commit 3) — bundler client. Constructed only
  // when MUHAVEN_BUNDLER_URL is set; undefined disables Path D and
  // position tools stay on the Path C dashboard deep-link contract.
  // Read-only mode also implicitly disables Path D (no position tools
  // to call) — but we still construct the client so a future read tool
  // that wants chain id can use it; cheap to keep.
  const bundler = config.bundlerUrl
    ? new BundlerClient({
        endpoint: config.bundlerUrl,
        requestTimeoutMs: config.bundlerTimeoutMs,
        expectedChainId: config.chainId,
      })
    : undefined;
  const baseRegistry = selectRegistry(config.readOnly);
  const registry = opts.filterRegistry ? opts.filterRegistry(baseRegistry) : baseRegistry;
  if (registry.length === 0) {
    process.stderr.write(
      '[muhaven-mcp] tool registry is empty after filtering — refusing to start.\n',
    );
    process.exit(70);
  }

  const server = buildMcpServer({
    registry,
    backend,
    broker: config.readOnly ? undefined : broker,
    bundler: config.readOnly ? undefined : bundler,
    dashboardBaseUrl: config.dashboardBaseUrl,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // bin/muhaven-mcp.cjs wraps this in `.then(() => process.exit(0))`. The
  // SDK's StdioServerTransport.connect resolves the moment the transport
  // is wired up — it does NOT block until the host closes stdin — so
  // returning here would tear the subprocess down before the host (Claude
  // Desktop / Cursor / Claude Code) sends its first JSON-RPC frame. Park
  // until the host closes stdin (clean shutdown) or sends SIGTERM.
  await new Promise<void>((resolve) => {
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
}
