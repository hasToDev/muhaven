/**
 * OpenClaw skill entry point. Bundles `@muhaven/mcp` with a hardcoded
 * tool subset per ADR-C: `read.*` (5) + Wave 4 P11 reads
 * (`read.protection_coverage`, `read.kyc_attestation`) +
 * `position.{buy,claim}` (2) + `policy.{pause,session_key_status}` (2)
 * = 11 tools. Eleven additional upstream tools (`position.{sell,
 * rebalance}` + `policy.{set_tier,audit_export}` + the five
 * `issuer.*` tools + the two `governance.*` tools) are deliberately
 * excluded — see `SKILL.md` `mcp.toolset_excluded_reason`.
 *
 * The skill does NOT mint its own MCP server — it imports `@muhaven/mcp`'s
 * `runMcpStdioCli` and supplies a `filterRegistry` callback that prunes
 * excluded tools. This keeps the descriptor SHA-256 hashes identical to
 * the upstream MCP package (post-MCPoison: hash drift in a bundled
 * subset would falsely trip the mcp-context-protector pin). Hash
 * verification fires inside `runMcpStdioCli` BEFORE the filter, so an
 * attacker who patches a single descriptor cannot hide the patch by
 * shipping a subset filter that excludes the patched tool — the patched
 * bytes still get hashed against the unfiltered `TOOL_DESCRIPTORS` array.
 *
 * The toolset_subset MUST stay in sync with `manifest.json`,
 * `manifest.json#tools`, and the SKILL.md frontmatter.
 * `scripts/verify-subset.ts` enforces this at build + CI gate time + via
 * a vitest at `__tests__/subset.test.ts` + `__tests__/manifest-consistency.test.ts`.
 */

import { runMcpStdioCli, type ToolEntry } from '@muhaven/mcp';

// Build-time constant injected by tsup `define` (see tsup.config.ts).
// Tests that import this module directly (without going through the
// bundled output) fall back to the runtime require of package.json so
// vitest doesn't trip on an undefined identifier.
declare const __SKILL_VERSION__: string | undefined;

/** Tool names exposed by this skill. ORDER-INDEPENDENT — used as a Set. */
export const TOOLSET_SUBSET: readonly string[] = [
  'muhaven.read.portfolio',
  'muhaven.read.yields',
  'muhaven.read.distribution',
  'muhaven.read.tokens',
  'muhaven.read.audit',
  // Wave 4 P11 — informational read tools fit the investor surface.
  'muhaven.read.protection_coverage',
  'muhaven.read.kyc_attestation',
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
  // Wave 4 P11 — governance ceremony requires the dashboard ConfirmModal
  // + cofhe encrypt ceremony, neither of which the OpenClaw skill
  // surface (Telegram bot / inline confirm) can drive. Investors who
  // want to vote follow the dashboard flow.
  'muhaven.governance.propose',
  'muhaven.governance.cast_vote',
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
          `The bundled_version triple-match guarantee (manifest.json#mcp.bundled_version === SKILL.md frontmatter ` +
          `bundled_version === packages/mcp/package.json#version) is supposed to catch this at install time — if you ` +
          `are seeing this at runtime, reinstall the skill at a compatible @muhaven/mcp version rather than patching ` +
          `in place. If reproduces on fresh install: https://github.com/hasToDev/muhaven/issues with the missing list.`,
      );
    }
  }

  return filtered;
}

/** Boot the skill's MCP STDIO server. */
export async function runOpenClawSkill(): Promise<void> {
  // Hard-set (not `??=`) so a host-supplied env var can't spoof the
  // version observed by audit/telemetry downstream. The build-time
  // constant comes from `tsup`'s `define` (sourced from
  // `package.json#version` — single source of truth). Tests that import
  // the unbundled module fall back to the runtime read.
  process.env.MUHAVEN_OPENCLAW_SKILL_VERSION = resolveSkillVersion();
  await runMcpStdioCli({ filterRegistry: selectOpenClawSubsetRegistry });
}

function resolveSkillVersion(): string {
  // `__SKILL_VERSION__` is replaced by tsup at build time. When the
  // module is imported directly (vitest, type-only consumers), it's
  // undefined; fall back to the package.json sibling.
  if (typeof __SKILL_VERSION__ === 'string' && __SKILL_VERSION__) {
    return __SKILL_VERSION__;
  }
  // Lazy require to keep ESM consumers happy. The fallback is only hit
  // in vitest where node_modules + the workspace package.json are both
  // reachable from this file's directory.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pkg = require('../package.json') as { version: string };
  return pkg.version;
}

// Bin shim (`bin/muhaven-rwa-skill.cjs`) is the only entry path; it
// imports `runOpenClawSkill` and handles fatal-error printing + exit.
// A direct-invocation guard here would never match in the CJS bundle
// (file:// vs Windows-backslash path mismatches) and adds dead bytes
// to the published tarball, so it's omitted.
