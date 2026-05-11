/**
 * Tool descriptions are the **single source of truth** for what each MCP
 * tool advertises to the host LLM. They are also hashed (SHA-256) at
 * package build time and the hashes shipped in `tool-hashes.json`.
 *
 * The mcp-context-protector pattern (post-MCPoison, Apr 2026) compares
 * the live description hash against the pinned hash on first use; a
 * mismatch implies either a malicious downgrade attack or an
 * out-of-band patch. Both warrant operator review before re-confirming.
 *
 * Naming convention is locked in `development/DEV_WAVE_4/TOOL_NAMESPACE.md`:
 *   muhaven.<group>.<verb>     ^muhaven\.[a-z]+\.[a-z][a-z0-9_]*$
 *
 * Renaming a tool is a breaking change — bump the package major.
 */

import { createHash } from 'node:crypto';

export interface ToolDescriptor {
  /** Canonical name. MUST match the regex in TOOL_NAMESPACE.md. */
  readonly name: string;
  /** Group classification — drives the --read-only filter. P7 adds
   *  `issuer` for issuer-side state-mutating tools that require an
   *  approved issuer kernel (the use-case-side gate produces structured
   *  403s for non-issuers; the group is for the read-only filter only).
   *
   *  P11 adds `governance` for the FHE-encrypted voting ceremony +
   *  protection-coverage / KYC-attestation reads. The two read tools
   *  (`muhaven.governance.protection_coverage`,
   *  `muhaven.governance.kyc_attestation`) are also exposed under
   *  `read` so `--read-only` keeps them available; the two propose
   *  tools (`muhaven.governance.propose`, `muhaven.governance.cast_vote`)
   *  are filtered off in read-only mode. */
  readonly group: 'read' | 'position' | 'policy' | 'issuer' | 'governance';
  /** Human-readable description shown in the host UI. */
  readonly description: string;
  /** When true, the host SHOULD render a confirmation cue before invoking. */
  readonly sensitive: boolean;
}

/**
 * The 22 Wave 4 MCP tools across five groups:
 *   muhaven.read.*       (7 — incl. P11 protection_coverage + kyc_attestation)
 *   muhaven.position.*   (4)
 *   muhaven.policy.*     (4)
 *   muhaven.issuer.*     (5 — P7)
 *   muhaven.governance.* (2 — P11; cast_vote frontend runner deferred to Wave 5)
 *
 * `MUHAVEN_READ_ONLY=true` exposes only the 7 `muhaven.read.*` tools.
 * P5's `muhaven.checkout.*` namespace was retired before Wave 4 close — the
 * hosted checkout surface ships as a separate Vite SPA (apps/checkout-pay/),
 * not as an MCP tool group.
 */
export const TOOL_DESCRIPTORS: readonly ToolDescriptor[] = [
  {
    name: 'muhaven.read.portfolio',
    group: 'read',
    description:
      'Return the authenticated investor\'s encrypted-balance portfolio summary. Output exposes only public aggregates (token list, ebool isOverexposed / isUnderYield handles); decrypted balances are NEVER included in the response. The LLM should call muhaven.read.portfolio for fact-checks about the user\'s state, not estimate from chat history.',
    sensitive: false,
  },
  {
    name: 'muhaven.read.yields',
    group: 'read',
    description:
      'Return per-token yield history (cleartext aggregates only — distribution dates, total funded amounts, epoch numbers). Use to answer "what was my yield last epoch?" with authoritative data, not from cached LLM context.',
    sensitive: false,
  },
  {
    name: 'muhaven.read.distribution',
    group: 'read',
    description:
      'Return distribution status for a (token, epoch). Inputs: token address (Hex), epoch (uint). Output: { state, totalFunded, escrowsCreated, escrowsFunded } — all cleartext aggregates.',
    sensitive: false,
  },
  {
    name: 'muhaven.read.tokens',
    group: 'read',
    description:
      'List the RWA tokens the authenticated user holds (token addresses + symbols + decimals). Balances are NOT included; use muhaven.read.portfolio for the encrypted-balance aggregates.',
    sensitive: false,
  },
  {
    name: 'muhaven.read.audit',
    group: 'read',
    description:
      'Return the authenticated user\'s tiered-autonomy audit log entries. Cursor-paginated. Useful for forensic review ("why was I paused?") and grant-reviewer demos. Read-only — never exposes other users\' data.',
    sensitive: false,
  },
  {
    name: 'muhaven.position.buy',
    group: 'position',
    description:
      'PROPOSE a Subscription buy. Returns an unsigned UserOp envelope plus a broker-signed session-key signature. The host MUST present the unsigned envelope to the user for passkey confirmation before submission to the bundler — this tool NEVER auto-submits. Fails when the user is in Advisory or Paused tier.',
    sensitive: true,
  },
  {
    name: 'muhaven.position.sell',
    group: 'position',
    description:
      'PROPOSE a redemption-queue sell. Same envelope-plus-signature pattern as muhaven.position.buy. Requires the user to be in Confirm-per-action or Policy-bound tier on the MCP surface.',
    sensitive: true,
  },
  {
    name: 'muhaven.position.claim',
    group: 'position',
    description:
      'PROPOSE a yield claim from RedemptionQueue / YieldSnapshot for a given token. Returns an unsigned UserOp + broker signature. Idempotent — proposing twice produces the same intent hash.',
    sensitive: true,
  },
  {
    name: 'muhaven.position.rebalance',
    group: 'position',
    description:
      'PROPOSE a multi-leg atomic rebalance bundling buy + sell legs into a single UserOp. Each leg is constrained by the user\'s installed @zerodev/permissions CallPolicy.',
    sensitive: true,
  },
  {
    name: 'muhaven.policy.set_tier',
    group: 'policy',
    description:
      'REQUEST or COMMIT a tiered-autonomy transition (Advisory ↔ Confirm-per-action ↔ Policy-bound) on the MCP surface. Two-step: first call returns a single-use confirmation token; the user passkey-signs in the dashboard; the host re-invokes with the token to commit. Step-down transitions skip the token. NEVER allows Advisory → Policy-bound in a single call (ADR-0).',
    sensitive: true,
  },
  {
    name: 'muhaven.policy.pause',
    group: 'policy',
    description:
      'Activate the /pause kill-switch. Backend marks the surface Paused immediately; the on-chain @zerodev/permissions uninstallPlugin UserOp envelope is returned for the user to submit via passkey. Cascade-mode (no surface arg) pauses all four Wave 4 surfaces atomically.',
    sensitive: true,
  },
  {
    name: 'muhaven.policy.audit_export',
    group: 'policy',
    description:
      'Stream the authenticated user\'s full audit log to a single JSON document. Convenience wrapper over muhaven.read.audit that drains the cursor — useful for compliance handoffs.',
    sensitive: false,
  },
  {
    name: 'muhaven.policy.session_key_status',
    group: 'policy',
    description:
      'Return the current ZeroDev session-key validator state for the MCP surface: tier, validator address, valid-until timestamp, recent action count. Pure read; never modifies state.',
    sensitive: false,
  },
  // ── Wave 4 P7 — issuer-side tools (ADR-8) ──────────────────────────
  // Same use-case backing as HavenBot's `muhaven_propose_*` tools; the
  // dotted MCP names follow the namespace rule established in P3
  // (TOOL_NAMESPACE.md §"`@muhaven/mcp` namespaces"). Every issuer tool
  // is sensitive=true (host MUST render confirmation cue); they require
  // an approved issuer kernel — the backend returns a structured 403
  // when the JWT subject isn't issuer-roled.
  {
    name: 'muhaven.issuer.distribute_yield',
    group: 'issuer',
    description:
      'PROPOSE a yield distribution for a registered RWA token. Wraps the @muhaven/sdk distributeYield pipeline (startDistribution → batchCreate → fundEscrows). Returns an ActionDescriptor + confirmation token. Issuer-only — the use-case rejects non-issuer kernels with NOT_APPROVED_ISSUER.',
    sensitive: true,
  },
  {
    name: 'muhaven.issuer.kyc_add',
    group: 'issuer',
    description:
      'PROPOSE adding an investor to the ERC-3643 whitelist for a registered token. kycTier=1 is retail KYC; kycTier=2 is accredited (which also requires tier 1). Returns an ActionDescriptor + confirmation token. Issuer-only.',
    sensitive: true,
  },
  {
    name: 'muhaven.issuer.kyc_remove',
    group: 'issuer',
    description:
      'PROPOSE removing an investor from the ERC-3643 whitelist for a registered token. Tier-2 accredited status is auto-cleared by the contract. The on-chain T-5 KYC-revocation cascade across investor surfaces wires up in Wave 5 once the indexer subscribes. Issuer-only.',
    sensitive: true,
  },
  {
    name: 'muhaven.issuer.unpause_token',
    group: 'issuer',
    description:
      'PROPOSE the F2 wizard step 6 closure: oracle.setNAV(token, initialNav) + tokenRegistry.setPaused(token, false). Both signed by the applicant kernel. Idempotent — refuses if the token is already active. Issuer-only.',
    sensitive: true,
  },
  {
    name: 'muhaven.issuer.audit_query',
    group: 'issuer',
    description:
      'Return the calling issuer\'s tiered-autonomy audit log entries (cursor-paginated). Useful for compliance review of past distributions, KYC additions, and unpause events. Wave 4 = issuer-self only; Wave 5 adds permit-gated cross-user access for compliance officers.',
    sensitive: false,
  },
  // ── Wave 4 P11 — governance / protection / KYC tools ──────────────
  // Reads land in `read` so `--read-only` keeps them available.
  // State-mutating governance ceremony lives in the new `governance`
  // group, filtered off by `--read-only`.
  {
    name: 'muhaven.read.protection_coverage',
    group: 'read',
    description:
      'Read-only inspection of DefaultProtection coverage for an RWA token. Returns the public reserveRateBps, status, issuer address, and a human-readable explanation. Encrypted reserve balances are NEVER decrypted server-side; only public aggregates surface. Returns "not_deployed" when the P11.A contract is not yet on-chain.',
    sensitive: false,
  },
  {
    name: 'muhaven.read.kyc_attestation',
    group: 'read',
    description:
      'Read-only informational tool that explains MuHaven cross-chain KYC attestations + returns the registry config (default validity period, attestation signer, jurisdiction hash). Use to answer "how does cross-chain KYC work?" with authoritative data. Returns "not_deployed" when the P11.C registry is not yet on-chain.',
    sensitive: false,
  },
  {
    name: 'muhaven.governance.propose',
    group: 'governance',
    description:
      'PROPOSE opening a governance proposal on the EncryptedGovernance contract. Wave 4 supports proposalType=0 (TRIGGER_PROTECTION) only; type=1 reserved for Wave 5. Returns an ActionDescriptor + confirmation token; the user signs through the dashboard ConfirmModal. Tier-gated. Refuses with P11_NOT_DEPLOYED when the contract is not yet on-chain.',
    sensitive: true,
  },
  {
    name: 'muhaven.governance.cast_vote',
    group: 'governance',
    description:
      'PROPOSE submitting an FHE-encrypted ballot on an EncryptedGovernance proposal. The cleartext yes/no is rendered for the user in ConfirmModal; the SDK encrypts to InEuint128 client-side BEFORE the on-chain write so the agent surface NEVER sees the encrypted handle. The audit log records that a vote was cast but does NOT record which way (privacy invariant).',
    sensitive: true,
  },
];

const _seenNames = new Set<string>();
for (const t of TOOL_DESCRIPTORS) {
  if (_seenNames.has(t.name)) {
    throw new Error(`Duplicate tool descriptor name: ${t.name}`);
  }
  _seenNames.add(t.name);
}

const TOOL_NAME_RE = /^muhaven\.[a-z]+\.[a-z][a-z0-9_]*$/;

for (const t of TOOL_DESCRIPTORS) {
  if (!TOOL_NAME_RE.test(t.name)) {
    throw new Error(
      `Tool name "${t.name}" violates muhaven.<group>.<verb> regex (TOOL_NAMESPACE.md rule)`,
    );
  }
}

/**
 * Hash a tool descriptor — the bytes that change when an attacker
 * rewrites a tool's *advertised behaviour*. Excluding `group` keeps the
 * hash stable across refactors that move a tool between groups; both
 * `name` and `description` are included because either changing alters
 * the LLM's interpretation of the tool.
 */
export function hashToolDescriptor(d: ToolDescriptor): string {
  const canonical = JSON.stringify({
    name: d.name,
    description: d.description,
    sensitive: d.sensitive,
  });
  return createHash('sha256').update(canonical, 'utf-8').digest('hex');
}

export interface ToolHashEntry {
  readonly name: string;
  readonly sha256: string;
}

export function buildToolHashTable(): readonly ToolHashEntry[] {
  return TOOL_DESCRIPTORS.map((d) => ({ name: d.name, sha256: hashToolDescriptor(d) }));
}

/** Compare a live descriptor against a pinned hash. Returns null on
 *  match; returns a structured mismatch payload on drift. */
export function verifyDescriptorAgainstPin(
  descriptor: ToolDescriptor,
  pinnedSha256: string,
): { liveSha256: string; pinnedSha256: string } | null {
  const live = hashToolDescriptor(descriptor);
  if (live === pinnedSha256) return null;
  return { liveSha256: live, pinnedSha256 };
}
