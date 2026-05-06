/**
 * OpenClaw skill entry point. Bundles `@muhaven/mcp` with a hardcoded
 * tool subset per ADR-C: `read.*` (5) + `position.{buy,claim}` (2) +
 * `policy.{pause,session_key_status}` (2) = 9 tools.
 *
 * The skill does NOT mint its own MCP server — it imports `@muhaven/mcp`'s
 * `runMcpStdioCli` and supplies a `filterRegistry` callback that prunes
 * excluded tools. This keeps the descriptor SHA-256 hashes identical to
 * the upstream MCP package (post-MCPoison: hash drift in a bundled
 * subset would falsely trip the mcp-context-protector pin).
 *
 * The toolset_subset MUST stay in sync with `manifest.json` and the
 * SKILL.md frontmatter. `scripts/verify-subset.ts` enforces this at
 * package build + CI gate time.
 */

import { runMcpStdioCli, type ToolEntry } from '@muhaven/mcp';

/** Tool names exposed by this skill. ORDER-INDEPENDENT — used as a Set. */
export const TOOLSET_SUBSET: readonly string[] = [
  'muhaven.read.portfolio',
  'muhaven.read.yields',
  'muhaven.read.distribution',
  'muhaven.read.tokens',
  'muhaven.read.audit',
  'muhaven.position.buy',
  'muhaven.position.claim',
  'muhaven.policy.pause',
  'muhaven.policy.session_key_status',
];

/** Tools deliberately excluded — see SKILL.md `mcp.toolset_excluded_reason`. */
export const TOOLSET_EXCLUDED: readonly string[] = [
  'muhaven.position.sell',
  'muhaven.position.rebalance',
  'muhaven.policy.set_tier',
  'muhaven.policy.audit_export',
  // Wave 4 P7 — issuer-side tools are out of scope for the OpenClaw
  // skill (investor-facing surface). Issuer flows live on HavenBot
  // in-dashboard + the standalone `@muhaven/mcp` install. The bundled
  // OpenClaw skill never advertises them.
  'muhaven.issuer.distribute_yield',
  'muhaven.issuer.kyc_add',
  'muhaven.issuer.kyc_remove',
  'muhaven.issuer.unpause_token',
  'muhaven.issuer.audit_query',
];

const SUBSET = new Set(TOOLSET_SUBSET);

/**
 * Pure function — returns the OpenClaw-allowed subset of `registry`.
 * Throws if any tool listed in `TOOLSET_SUBSET` is missing from the live
 * registry (signals an upstream version drift that must be reconciled
 * before the skill can boot).
 *
 * Note: `--read-only` mode in the upstream package narrows `registry` to
 * `read.*` only BEFORE this filter runs; in that case the OpenClaw
 * subset shrinks accordingly (read tools only). That's the intended
 * behaviour — read-only is strictly subset of the read-only-allowed
 * portion of the OpenClaw subset.
 */
export function selectOpenClawSubsetRegistry(
  registry: readonly ToolEntry[],
): readonly ToolEntry[] {
  const upstreamNames = new Set(registry.map((e) => e.descriptor.name));
  const filtered = registry.filter((e) => SUBSET.has(e.descriptor.name));

  // Cross-check that every name we INTEND to expose is present upstream
  // and is NOT in the read-only-only path. We allow a partial subset
  // ONLY when MUHAVEN_READ_ONLY narrowed the upstream first — detect
  // that by seeing if any non-read tool is in the upstream registry.
  const upstreamHasNonRead = registry.some((e) => e.descriptor.group !== 'read');
  if (upstreamHasNonRead) {
    const missing = TOOLSET_SUBSET.filter((name) => !upstreamNames.has(name));
    if (missing.length > 0) {
      throw new Error(
        `[openclaw-skill] tool-subset drift: missing ${missing.join(', ')} from upstream @muhaven/mcp registry. ` +
          `Either update TOOLSET_SUBSET / manifest.json or pin to a compatible @muhaven/mcp version.`,
      );
    }
  }

  return filtered;
}

/** Boot the skill's MCP STDIO server. */
export async function runOpenClawSkill(): Promise<void> {
  process.env.MUHAVEN_OPENCLAW_SKILL_VERSION ??= '0.1.0';
  await runMcpStdioCli({ filterRegistry: selectOpenClawSubsetRegistry });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runOpenClawSkill().catch((err) => {
    process.stderr.write(
      `[openclaw-skill] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
