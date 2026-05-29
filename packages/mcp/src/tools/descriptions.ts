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
  readonly group: 'read' | 'position' | 'policy' | 'issuer' | 'governance' | 'cash';
  /** Human-readable description shown in the host UI. */
  readonly description: string;
  /** When true, the host SHOULD render a confirmation cue before invoking. */
  readonly sensitive: boolean;
}

/**
 * The 25 MCP tools across six groups:
 *   muhaven.read.*       (8 — incl. P11 protection_coverage + kyc_attestation
 *                            + 0.2.1 read.activity for Path C settle verify)
 *   muhaven.position.*   (4)
 *   muhaven.cash.*       (2 — Path C: wrap (0.1.7) + unwrap (Wave 5 W3 / 0.5.1))
 *   muhaven.policy.*     (4)
 *   muhaven.issuer.*     (5 — P7)
 *   muhaven.governance.* (2 — P11; cast_vote frontend runner deferred to Wave 5)
 *
 * `MUHAVEN_READ_ONLY=true` exposes only the 8 `muhaven.read.*` tools.
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
    name: 'muhaven.read.activity',
    group: 'read',
    description:
      'Return the authenticated investor\'s on-chain activity feed (buys / sells / wraps / unwraps / yield claims / transfers). Each row carries token address, tx hash, block timestamp, and event type — but NEVER cleartext amounts (encrypted handles only, decryptable client-side via permit). USE THIS to verify a Path C dashboard action settled: after position.buy / position.sell / cash.wrap, the user opens the deep-link, taps Authorize, the on-chain tx lands → a new row appears here. Far more reliable than re-calling read.portfolio (which only changes shape when a NEW token enters the catalog).',
    sensitive: false,
  },
  {
    name: 'muhaven.position.buy',
    group: 'position',
    description:
      'Prepare a Subscription buy. Returns a dashboard deep-link URL (muhaven.app/trade?mode=buy&...) the user opens to review the pre-filled form, then taps Authorize. The user\'s passkey + ZeroDev kernel sign on the dashboard — this MCP tool never holds or submits a signing key. Use after the user names a clear amount + token (e.g. "Buy 5 mhUSDC of TBILL1" → `amountUsdc: "5"`). Token accepts either a symbol ("TBILL1") or 0x-address. The `amountUsdc` field is HUMAN-DECIMAL mhUSDC ("5" = 5 mhUSDC, "0.5" = half a mhUSDC) — NOT base-6 integer. Max 6 fractional digits. The tool fetches the current on-chain NAV for the token and converts the notional to integer shares (floor) before building the URL — so "Buy 3 mhUSDC of GOLD1" at NAV $0.01 becomes "Buy 300 GOLD1 shares (~3 mhUSDC)". Refuses with `amount_too_small_for_share` when the notional won\'t buy at least 1 share at current NAV; the error message tells the user the minimum mhUSDC needed. Settlement is NOT observable from MCP — verify by calling muhaven.read.activity after the user confirms done (a new "buy" row with the tx hash will appear).',
    sensitive: true,
  },
  {
    name: 'muhaven.position.sell',
    group: 'position',
    description:
      'Sell (redeem) RWA shares back to mhUSDC. When an active Scoped autonomy session is present it submits the redeem autonomously (same broker-signed path as position.buy) and returns the tx hash directly; otherwise it returns a dashboard deep-link (muhaven.app/trade?mode=sell&...) the user opens + authorizes with their passkey. Input is amountShares (raw POSITIVE INTEGER share count, NOT mhUSDC notional) — fhERC-20 shares have no decimals so fractional inputs are rejected. By default it does an INSTANT redeem, which on-chain auto-escalates to the token\'s redemption queue if it overflows the instant capacity (the result reports settlement: "instant" | "escalated" with the queue requestId). Set viaQueue: true ONLY when the user explicitly wants to queue the sell directly (settlement: "queued"). IMPORTANT over-sell caveat: selling MORE shares than the holder owns silently burns ZERO on-chain (a no-op, NOT a partial fill) — balances are encrypted so this cannot be pre-checked; ALWAYS verify settlement afterward via muhaven.read.activity (look for a "sell" / "sell-queued" row with the tx hash) and warn the user if no balance change landed.',
    sensitive: true,
  },
  {
    name: 'muhaven.position.claim',
    group: 'position',
    description:
      'Claim matured yield for an epoch. When an active Scoped autonomy session is present AND a concrete escrowId (the epoch id) is given, it submits claimYield autonomously (broker-signed, same path as position.buy/sell) and returns the tx hash directly; otherwise — no active session, OR no escrowId — it returns a dashboard deep-link URL (muhaven.app/yields?...) the user opens and passkey-signs. escrowId is the epoch id: when set, the matching row is highlighted + scrolled into view; when omitted, the page renders the full claimable list and the user picks (autonomous claim REQUIRES a concrete epoch — without one it always deep-links). The claimed amount is computed on-chain and stays encrypted (amount-blind). Verify settlement via muhaven.read.activity (a "claim" row with the tx hash) — amounts are never shown.',
    sensitive: true,
  },
  {
    name: 'muhaven.position.rebalance',
    group: 'position',
    description:
      'NOT IMPLEMENTED in this release — returns an error pointing the user at single-leg position.buy / position.sell or the dashboard /trade page. Multi-leg execute_plan lands in Wave 5 with a composite preview UI + executeBatch on the kernel.',
    sensitive: true,
  },
  // ── Path C cash group (2026-05-18) ────────────────────────────────
  {
    name: 'muhaven.cash.wrap',
    group: 'cash',
    description:
      'Prepare a USDC → mhUSDC wrap (the encrypted-balance conversion that funds buys). Returns a dashboard deep-link URL (muhaven.app/cash?amount=...&from=mcp) with the amount pre-filled. Input amountUsdc is human-readable USDC ("100" = $100). Common LLM chain: read.portfolio → notice 0 mhUSDC → cash.wrap → then position.buy (each is its own user-confirmed deep-link). Verify settlement by calling muhaven.read.activity (a new "wrap" row will appear with the tx hash).',
    sensitive: true,
  },
  {
    name: 'muhaven.cash.unwrap',
    group: 'cash',
    description:
      'User-initiated only (no autonomous Path-D). Prepare an mhUSDC → USDC withdrawal (inverse of cash.wrap; Wave 5 W3). Returns a dashboard deep-link (muhaven.app/cash?mode=unwrap&...) that lands on the Withdraw form. Input amountUsdc is the dollar amount to convert back; mhUSDC↔USDC is 1:1 at 6 decimals so "withdraw 50 mhUSDC" or "convert $50 back to USDC" both map to amountUsdc: "50" (never include "$" or convert to base units). Optional — omit to let the user pick on the form. Two-phase async: (1) burn mhUSDC + request coprocessor decrypt (~30-60s), (2) claim USDC from the wrapper\'s on-chain reserve. The dashboard form drives both phases; this tool NEVER submits the burn or claim. To verify in-conversation, call muhaven.read.activity ONLY AFTER the user reports the claim landed — look for an "unwrap" row with a non-null claim tx hash. Seeing only the burn row means step 2 has not happened yet (do NOT declare settled).',
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
