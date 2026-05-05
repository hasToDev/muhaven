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
import { selectRegistry, type ToolEntry } from './tools/registry.js';
import {
  TOOL_DESCRIPTORS,
  hashToolDescriptor,
  type ToolHashEntry,
} from './tools/descriptions.js';

const SERVER_NAME = '@muhaven/mcp';
const SERVER_VERSION = '0.1.0';

interface AuthRequiredPayload {
  ok: false;
  code: 'AUTH_REQUIRED';
  message: string;
  loginCommand: string;
}

function authRequiredPayload(): AuthRequiredPayload {
  return {
    ok: false,
    code: 'AUTH_REQUIRED',
    message:
      'No JWT in broker keystore. Run `muhaven-broker login` to authenticate via the device-code ceremony, then retry this tool.',
    loginCommand: 'muhaven-broker login',
  };
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
        surface: 'mcp',
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

/** Production STDIO entrypoint — wired through `bin/muhaven-mcp.cjs`. */
export async function runMcpStdioCli(): Promise<void> {
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
  const registry = selectRegistry(config.readOnly);

  const server = buildMcpServer({
    registry,
    backend,
    broker: config.readOnly ? undefined : broker,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
