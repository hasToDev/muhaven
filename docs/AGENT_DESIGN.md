# MuHaven — AI Agent Design

> Architecture for the Wave 4 agentic layer. Four surfaces, tiered autonomy, hybrid policy storage. Status, threat model, and rollout in one document.

---

## Status

**Wave 3.** The agent **chat UI is scaffolded** (`frontend/src/views/AgentPage.vue` + `frontend/src/components/agent/*`) and wired to a backend stub at `/api/v1/agent/chat`. Investors and issuers drive every flow directly from the Vue dashboard today — buy, redeem, claim, snapshot, fund, NAV writes.

**Wave 4 P2 update (2026-05-06).** HavenBot is live on `agenticwave`. The chat UI now consumes a real SSE streaming endpoint (`/api/v1/agent/chat/stream`) backed by the 8-tool surface + uniform tool dispatcher + per-action `<ConfirmModal>` with cleartext preview + on-chain SDK call via the user's ZeroDev kernel. Provider is Google Gemini via `@google/genai` (one-file swap to Claude via Vercel AI SDK when the user adds a Claude key — see ADR-6 D1). Onboarding wizard at `/agent/onboarding` ships the Wealthfront-style limits paragraph + sealed-glass-envelope copy + portfolio-probe restoration so returning users skip past completed steps.

**Wave 4 — in active development on a parallel branch (~203h of ~327h shipped, awaits production cutover settlement before merge).** Four agentic surfaces sitting on the same MuHaven SDK + `@zerodev/permissions` policy gate:

- **HavenBot** — in-dashboard streaming chat (Vue 3, Anthropic Claude Sonnet 4.5 via Vercel AI SDK).
- **`@muhaven/mcp`** — MCPB-format MCP server with companion `muhaven-broker` daemon (OS-keychain credentials, Unix-socket signing).
- **OpenClaw skill** (`muhaven-rwa-skill`) — published to ClawHub via Sigstore + GitHub OIDC; bundles a subset of the MCP toolset; Telegram surface with three confirmation tiers.
- **Hosted checkout** (`pay.muhaven.app`) — Stripe-pattern URL with AES-256-GCM enc_payload + HMAC-SHA256 webhooks + ZeroDev passkey ceremony for first-time buyers.

Plus a **tiered-autonomy state machine** (Advisory / Confirm-per-action / Policy-bound) with hybrid policy storage (encrypted thresholds in `RiskParams.sol`, plaintext rule-shape in `@zerodev/permissions` validators).

**Canonical Wave 4 plan.** [`development/WAVE_PLAN.md` § "Wave 4"](../development/WAVE_PLAN.md). Phase tracking: [`development/DEV_WAVE_4/PROGRESS.md`](../development/DEV_WAVE_4/). Research artifacts: [`development/research-docs/WAVE_4_AGENTIC_RESEARCH_RESULT.md`](../development/research-docs/).

---

## What the agent does

A regular LLM answers questions. An agent **does things**.

When you ask ChatGPT "what's the best RWA yield?", it answers. When you tell HavenBot "buy $500 of TBILL1 from a stablecoin position", it checks current rates, pulls the deviation-gated NAV, recommends an allocation, gets your approval, signs the UserOp through your kernel + scoped session key, and settles atomically through `MuHavenSubscription.purchase`. Encrypted balances never leave your local decrypt permit.

Three components:

1. **Brain.** An LLM (Claude Sonnet 4.5) that understands natural language and produces structured tool-call intents. The LLM never holds keys and never directly invokes a wallet method.
2. **Policy gate.** A deterministic engine between the LLM and the signing path that validates each intent against the user's tiered-autonomy mode + on-chain policy primitives. Rejected intents short-circuit before any signing happens.
3. **Tools.** Typed function surfaces backed by the MuHaven SDK. Read tools (portfolio summary, quote, oracle status) require no signing. Write tools route through the policy gate, then the user's ZeroDev kernel + scoped session key.

```
User says something
       │
       ▼
┌──────────────────┐
│  HavenBot LLM    │ ── reads context (tier, recent audit, tool availability)
│  produces tool   │
│  intent JSON     │
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│  Policy gate     │ ── tier check (Advisory/Confirm/Policy-bound)
│  (deterministic) │ ── @zerodev/permissions validator scope
│                  │ ── RiskParams encrypted threshold check (FHE.gte breach path)
└──────┬───────────┘
       │ approved
       ▼
┌──────────────────┐
│  MuHaven SDK     │ ── kernel + session-key sender writes the UserOp
│  call            │ ── ZeroDev bundler relays
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│  Audit log       │ ── WORM append, permit-grant events recorded
└──────────────────┘
```

Prompt-injection attempts that would have triggered an off-policy tool call are rejected by the policy gate before the LLM's intent reaches a signer. The CaMeL planner/action split (Wave 4 P8) keeps the planner LLM out of the signing path entirely.

---

## Four surfaces

Each surface is a different way to reach the same SDK + policy gate. Naming and scope are locked decisions per Wave 4 ADRs (see `development/WAVE_PLAN.md` for the architecture-decisions table).

### Surface 1 — HavenBot (in-dashboard copilot)

- Where: `/agent` route in the Vue 3 dashboard.
- Stack: Anthropic Claude Sonnet 4.5 via Vercel AI SDK; streaming chat; per-action `<ConfirmModal>` component with FHE-decrypted preview (`cofheClient.decryptForView(handle).withPermit().execute()`).
- Onboarding flow: passkey → KYC → first-buy in <6 minutes (Wealthfront-style limits paragraph; "sealed-glass-envelope" copy from research Q17).
- Tool surface: `muhaven_portfolio_summary`, `muhaven_quote`, `muhaven_propose_buy`, `muhaven_propose_claim`, `muhaven_propose_rebalance`, `muhaven_set_policy`, `muhaven_pause`, `muhaven_unseal_position`.

Demo loop: split-screen chat → encrypted balance unsealed client-side → buy proposal → passkey signature → Arbiscan settlement.

### Surface 2 — `@muhaven/mcp` MCPB server

- Format: MCPB npm package with `manifest.json` declaring every env var + binary + endpoint. **All secrets `"sensitive": true` → OS keychain.** No env-block credentials.
- Companion daemon: `muhaven-broker` (Node 20, ~200 LOC) listening on a Unix socket with peer-credential ACLs. Holds the session-key private half. MCP calls `signUserOp` over `/tmp/muhaven-broker.sock` (or named pipe on Windows).
- Toolsets: `muhaven.read.*` (portfolio, yield, distribution), `muhaven.position.*` (buy, claim, redeem), `muhaven.policy.*` (set tier, pause, audit). `--read-only` flag analogous to `github/github-mcp-server`.
- Hardening: tool-description pinning (`mcp-context-protector` pattern, post-MCPoison); transports bound to `127.0.0.1`; `mcp-remote` banned; `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` documented in setup.
- Publish: npm OIDC + provenance attestations; Sigstore signing.
- Install demos: Claude Desktop, Cursor, Claude Code.

Demo loop: install in Claude Desktop, ask "what's my yield this epoch?" → tool call → keychain unlock → broker signs userOp via Unix socket → result.

### Surface 3 — OpenClaw skill bundling VibeKit MCP

- Skill folder published to ClawHub: `SKILL.md` frontmatter, `manifest.json` permissions, `config.json` (ClawSecure-style), bundled MCP server (subset of P3).
- Sigstore signing + GitHub OIDC trusted publishing; two-maintainer release.
- CI: `openclaw skills publish --scan` (VirusTotal multi-engine + Code Insight) + Snyk `mcp-scan`.
- Telegram surface via OpenClaw gateway with three confirmation tiers:
  - **≤ $200**: inline keyboard preview → confirm
  - **$200 – $5K**: Mini App + 6-digit OTP (mailed via passkey-auth'd webhook)
  - **> $5K**: deep-link to passkey signature in browser
- Issuer-side: `.well-known/agent.json` A2A Agent Card for VibeKit / Google ADK discovery (discovery only — A2A is not the payment rail per research §6).

Demo loop: investor in Telegram says "buy $500 of TBILL1" → inline keyboard preview → deep-link to passkey → settles on Arbitrum.

### Surface 4 — Hosted checkout `pay.muhaven.app`

- Hono service deployed on Cloudflare Workers (or Bun); Drizzle/Postgres `checkout_sessions` table.
- URL scheme: `https://pay.muhaven.app/c/<ulid>#k=<base64url(32B)>`. Server-side `enc_payload = AES-256-GCM(plaintext, key=HKDF(k))`; 30-min TTL. **The key never reaches the server** — fragments are not sent in `Referer`, so the server holds ciphertext useless without the key.
- Webhook signing: `MuHaven-Signature: t=<unix>,v1=<HMAC-SHA256(t.body, whsec_…)>` over raw body, 5-min replay window. `Idempotency-Key` header dedupe. SSRF guard on outbound webhook URLs.
- Realtime: in-process SSE channel (replaces Supabase Realtime — avoids leaking session metadata to third-party SaaS).
- ZeroDev passkey ceremony for non-customer buyers: provisions kernel account on first use via `@zerodev/passkey-validator` + `createKernelAccount`. **Passkey RP ID = eTLD+1** (`muhaven.app` prod / `muhaven.hasto.dev` stage) so kernels recovered at checkout work in the dashboard.
- Issuer DID/OnchainID resolution to verified label ("You are paying [Issuer Verified]" — Stripe pattern).
- Funding flow: testnet uses faucet redirect (Option A, locked decision 2026-04-30). Pluggable `<FundingProvider>` Vue component for Wave 5 fiat on-ramp swap (Sardine / Coinbase Onramp / MoonPay).

Demo loop: issuer pastes URL into Telegram → investor clicks → passkey → faucet redirect (testnet) / on-ramp (mainnet) → confirms encrypted amount preview → settles → SSE returns receipt.

---

## Tool catalog

Tools are typed function surfaces. Each carries strict-enum names, structured-output schemas with `additionalProperties: false`, and runs through the deterministic policy gate before any signing. Names are namespaced — `muhaven_*` for HavenBot, `muhaven.read.*` / `muhaven.position.*` / `muhaven.policy.*` for MCP / OpenClaw.

### Investor-facing

| Tool | What it does | Backed by |
|---|---|---|
| `muhaven_portfolio_summary` | Encrypted balance preview + `ebool` signal flags (`isOverexposed`, `isUnderYield`) | CoFHE `decryptForView` + permit; flags computed in `RiskParams.computeSignalFlags` |
| `muhaven_quote(asset, amount)` | Cleartext NAV × amount preview before purchase | `IPriceOracle.getNAV(token)` |
| `muhaven_propose_buy(token, amount, maxSharesHint?)` | Atomic purchase via `MuHavenSubscription.purchase` | MuHaven SDK `SubscriptionClient.purchase` |
| `muhaven_propose_redeem(token, encShares)` | Instant redeem with auto-escalate to queue on cap overflow | `SubscriptionClient.redeem` |
| `muhaven_propose_claim(token, epochId)` | Pull yield for a finalized epoch | `YieldSnapshotClient.claimYield` |
| `muhaven_set_policy(tier, params)` | Tiered-autonomy state machine: Advisory / Confirm-per-action / Policy-bound | `@zerodev/permissions` validators + `RiskParams.setRiskParams` |
| `muhaven_pause` | Single-tx kill-switch — uninstalls active session validator (≤1 Arb block, ~250ms soft) | ZeroDev kernel `uninstallPlugin` |
| `muhaven_unseal_position(handle, permit)` | Permit-based decrypt of a specific handle | CoFHE `decryptForView` |
| `muhaven_check_protection_coverage(token)` | Read public `reserveRateBps` from `DefaultProtection` | DefaultProtection (Wave 4 P11) |
| `muhaven_propose_governance_vote(proposalId)`, `muhaven_cast_encrypted_vote(proposalId, choice)` | Encrypted ballot via `FHE.select` + async tally | EncryptedGovernance (Wave 4 P11) |
| `muhaven_explain_kyc_attestation` | Informational only — explains the cross-chain KYC attestation flow | KYCAttestationRegistry stub (Wave 4 P11.C) |

### Issuer-facing

| Tool | What it does | Backed by |
|---|---|---|
| `muhaven_distribution_wizard(token, totalYield, ratePerShare)` | Open epoch → snapshot holders → finalize → fund mhUSDC | `YieldSnapshotClient` |
| `muhaven_kyc_whitelist_add(account)`, `muhaven_kyc_whitelist_remove(account)` | Direct ERC-3643 wrapper | `IdentityRegistryClient` |
| `muhaven_audit_view(scope, filter)` | Read-only audit copilot with permits-based decrypt for compliance officer | `agent_audit_events` table + investor-signed grant |
| `muhaven_set_token_compliance(token, modules)` | Bind / unbind compliance modules (CountryAllow, MaxHolders, Lockup, …) | `ModularCompliance` |

All tool definitions live in `backend/src/agent/tools/*.ts` (Wave 4); HavenBot consumes them via Vercel AI SDK tool-call schemas, MCP exposes them through MCPB tool-list, OpenClaw bundles a subset.

---

## Tiered autonomy

The investor chooses a tier; the policy gate enforces it on every intent. Tier selection is itself a `muhaven_set_policy` call signed by the user's passkey.

### Advisory (default for fresh investors)

- LLM proposes; user signs each action with passkey.
- No session-key delegation; no policy-bound automation.
- Used during onboarding (<30 days, <$5K cumulative deposits) per SEC IM-2017-02 + FINRA Reg BI Care Obligation framing.

### Confirm-per-action

- LLM proposes; user confirms with passkey **or** session-key signature within the active 1-hour session.
- Per-action `<ConfirmModal>` shows the FHE-decrypted preview before signing.
- Default for returning users (≥5 confirmed actions, no breach in last 30 days).

### Policy-bound

- LLM proposes; deterministic policy engine validates against the user's encrypted thresholds in `RiskParams.sol` + plaintext rule-shape in `@zerodev/permissions` validators; signs without per-action confirmation when within bounds.
- Breaches emit a `RiskBreach` event, auto-pause to Advisory, and notify the user.
- Available immediately for accredited / power users; default flip-on at ≥5 confirmed actions for returning users.

State machine implementation: `backend/src/agent/policy-engine/` (Wave 4 P1). Cron tick: 60s, encrypted-input check via `cofhejs.encrypt` → `RiskParams.checkAndExecute(eAmount, action)` → on breach, `decryptForTx` + on-chain `settleBreachDecrypt(handle, cleartext, signature)`.

---

## Hybrid policy storage

Pure-encrypted-on-chain rules cost 3–8s + ~$0.05–0.20 per check **and** leak decrypt-event timing (correlate decrypt frequency to swap frequency → infer position size). Pure-plaintext rules expose strategy to the operator. The Wave 4 plan splits the difference:

| Slot | What's encrypted | What's plaintext | Rationale |
|---|---|---|---|
| Threshold values (max drawdown, min yield, drift, max daily spend) | `euint64` in `RiskParams.sol` | — | Numeric thresholds are the privacy-sensitive piece |
| Rule shape (which selector? which target? which time window?) | — | `@zerodev/permissions` validator config (on-chain) | Selector-allowlist + value-cap + epoch-cap + `validUntil` are public by design — what makes a session key valid is verifiable on-chain |
| Trigger logic | — | Backend cron + `RiskParams.checkAndExecute` (encrypted-amount input → encrypted comparison) | Off-chain trigger keeps the hot path ~1 block / ~$0.02–0.10 with no decrypt-event leakage |

Branchless `FHE.select` in `RiskParams.checkAndExecute(eAmount, action)` for the hot path:

```solidity
ebool withinDrawdown = FHE.lte(eAmount, _maxDrawdown[user]);
ebool withinDaily    = FHE.lte(_dailySpent[user] + eAmount, _maxDailySpend[user]);
ebool ok             = FHE.and(withinDrawdown, withinDaily);
euint64 chargedAmount = FHE.select(ok, eAmount, FHE.asEuint64(0));
// ... no decrypt on hot path; downstream contracts apply chargedAmount
```

`decryptForTx` + on-chain `settleBreachDecrypt` only on breach path; emits `RiskBreach` event. Preserves no-decrypt-timing privacy property.

P0 latency-bench result (2026-04-30, Arb Sepolia, 10 iters, 100% success rate): `decryptForTx` p50 = 1.22s / p99 = 1.25s; `decryptForView` p50 = 477ms / p99 = 485ms. End-to-end breach commit = ~1.2s TN + ~1.5s `settleBreachDecrypt` Arb tx ≈ 2.5–3s — comfortably under the 3-8s research target. Full table: `development/DEV_WAVE_4/LATENCY_BENCH_REPORT.md`.

---

## Wallet model

Earlier drafts proposed a dedicated agent wallet funded with a capped USDC balance. That model was retired in Wave 3 Phase 8 in favor of the ZeroDev passkey kernel + session-key system. The agent never holds a private key.

```
User passkey (WebAuthn, on device)
│
└── ZeroDev kernel smart account (EIP-4337)
    │
    ├── First sign-in: passkey dialog → kernel deploy + session-key install
    ├── Subsequent writes: signed locally by session key (no passkey prompt)
    │                      scope = narrow allowlist of MuHaven functions
    │                      TTL   = VITE_SESSION_KEY_DURATION_SEC (default 1h)
    │
    └── Wave 4: agent delegated actions reuse the same kernel
        ├── Tighter session-key scope when an agent acts on the user's behalf
        │   (per-target selector allowlist, value cap per call, total cap per epoch,
        │    validUntil ≤ chat session)
        ├── Per-action confirmation modal in Confirm-per-action tier
        ├── Deterministic policy gate (CaMeL planner/action split) — LLM's intent
        │   never reaches a signer until validated against on-chain policy
        └── Audit log (WORM, permit-grant events) for every tool call
```

Implementation reference: `frontend/src/providers/zerodev/`, `frontend/src/providers/session-key.ts`, `backend/src/agent/policy-engine/` (Wave 4). Design rationale: `development/DEV_WAVE_3/PROMPT_REDUCTION_PLAN.md`. EIP-7702 native session-key migration stays on the roadmap once wallet support lands.

---

## Auth posture (no third-party IdP, by design)

**Every auth primitive across the agent layer is self-hosted.** Auth0 / Okta / Firebase Auth / Clerk / Magic / Supabase Auth — none of them appear anywhere in the stack. This is a deliberate architectural decision driven by the threat model, not a backlog item awaiting an integration.

| Surface | Auth primitive | Backed by |
|---|---|---|
| Dashboard (`muhaven.hasto.dev`) | **SIWE (EIP-4361)** → JOSE-signed JWT | ZeroDev passkey kernel (WebAuthn). `backend/src/infrastructure/auth/jwt.service.ts` |
| HavenBot `/agent` chat (Wave 4 P2) | Same SIWE JWT + `withScope(['mcp.read.*' \| 'mcp.propose.*'])` | Inherits dashboard auth |
| `@muhaven/mcp` server (Wave 4 P3) | **OAuth 2.0 Device Authorization Grant (RFC 8628)** → scoped JWT in OS keychain | `@napi-rs/keyring` + `muhaven-broker` daemon over Unix socket. Self-hosted endpoints under `/api/v1/auth/device/*`. |
| Telegram / OpenClaw (Wave 4 P4) | Bot service-secret + Telegram `initData` HMAC-SHA256 + dashboard JWT for >$5K tier | All self-verified |
| Hosted checkout (Wave 4 P5) | URL-as-capability (~127-bit sessionId entropy) + AES-256-GCM payload + WebAuthn passkey at first use | Self-hosted, RP-ID pinned to dashboard hostname |

### Why no Auth0 / external IdP

Five reasons, in priority order:

1. **WebAuthn RP-ID pinning is the load-bearing phishing-resistance control.** ADR-3 D4 makes this explicit: a phishing site at `muhaven-link.com` literally cannot complete the passkey ceremony because the browser enforces RP-ID match. Routing through an external IdP would either replace the WebAuthn ceremony (kernels become unrecoverable from the dashboard) or layer on top of it (doubling the auth surface for zero security gain).
2. **Trust anchor is wallet-rooted, not identity-provider-rooted.** Investors prove control via SIWE signature; smart-account recoverability flows from passkey-on-device. Adding an IdP creates the confused-deputy hole that ADR-3 D2 (scoped JWT) was designed to close.
3. **Privacy-boundary forbids operator-side metadata leaks.** R-1 and R-7 say strategy + auth events stay private from operator infra. An external IdP sees every login event for every surface — metadata it monetizes and stores. Self-hosted JWT emits no such signal.
4. **R-7 (MCP env-block exfiltration)** is solved by `@napi-rs/keyring` + the broker daemon, not by an external IdP. External-IdP bearer tokens have identical exfil characteristics — adding one wouldn't have fixed R-7, just relocated the secret.
5. **Cost asymmetry**: external IdPs price ~$0.20/MAU at scale. For a confidential-RWA platform aiming for millions of investors that's real money for zero security gain over self-hosted.

### Where an IdP MIGHT land later

- **Enterprise SSO for issuers** (Okta / Azure AD) in Wave 5+ if institutional issuers need it. Would NOT replace investor-side passkey/SIWE; would land as an alternate route through `apply-issuer`.
- **OIDC federation for compliance officers** — same shape; Wave 5+ scope for the read-only audit copilot path.

Investor-side SIWE + WebAuthn + scoped JWT + device flow is the floor — adding to it (for issuer SSO) is fine; replacing it (for investor convenience) is not.

---

## Threat model

Wave 4-specific risk register. Augments the project-wide register at `development/WAVE_PLAN.md` § "Risk register".

| ID | Risk | Severity | Mitigation |
|---|---|---|---|
| **R-1** | Prompt injection that tricks the agent into permit-granting / unauthorized tx (OWASP LLM01:2025 + Excessive Agency). Precedents: EchoLeak (M365 Copilot 2025), CVE-2025-53773 GitHub Copilot RCE, Cursor+Jira 0-click exfil (Zenity Aug 2025). | High | Willison's lethal-trifecta avoidance + CaMeL planner/action split (P8). All `FHE.allow` / `cofheClient.permit` / ZeroDev permission upgrades pass through deterministic policy gate, not LLM-evaluated. PromptArmor preprocessing layer; structured-output schemas with strict enums. |
| **R-2** | LLM hallucinated tool call (calls `withdraw` when user asked balance). Precedents: April 2026 Claude Code production-DB-deletion incident; OpenClaw inbox-wipe at Meta. | High | Read/write API segregation on separate ZeroDev permissions and separate confirmation surfaces. Two-stage propose-then-execute: agent emits intent JSON, deterministic policy engine validates, then submits. No free-form tool names — strict enums. |
| **R-3** | Replay attacks on confirmation tokens (Telegram callback, MCP tool-call). Precedents: CVE-2025-54136 MCPoison; Forcepoint Telegram-bot replay via predictable `message_id`s; @bissapwned_bot campaign. | Medium | Single-use confirmation tokens, server-side nonce table bound to `(user_id, action_hash, expiry)`. Hash entire `(command, args, env)` tuple — re-approve on any change. ZeroDev session keys with `validUntil ≤ confirmation TTL`. Telegram outbound webhook with `secret_token` header, not `getUpdates` polling. |
| **R-4** | Backend compromise of cron policy engine (npm supply-chain). Precedents: Sept 2025 qix-maintainer phish (chalk/debug/ansi-styles, 2.6B weekly dl, Web3 wallet-drainer payload); Shai-Hulud worm; CVE-2025-55182 React2Shell (DFIR Report Apr 2026, 65K `.env` files exfiltrated). | High | `npm ci` with locked `package-lock.json`; `--ignore-scripts`; Socket / Snyk / Aikido CI gates; reject any package update <7 days in registry; secrets in HashiCorp Vault / Doppler with short TTL (never `.env` files); WAF + outbound-allowlist proxy on the policy engine; rotate ZeroDev paymaster + Fhenix relayer keys on schedule; canary tokens. |
| **R-5** | Supply-chain on agent skills / OpenClaw (ClawHavoc Feb 2026: 1,184+ malicious skills; Atomic macOS Stealer payloads; SOUL.md/MEMORY.md memory-poisoning for delayed execution; CVE-2026-25253 one-click RCE). | High | No third-party skills installed on MuHaven operator infra. Vendor any needed agent skills in-tree, code-review, sign with Sigstore + GitHub OIDC, two-maintainer release. Run inside Docker MCP Toolkit with `--block-network --block-secrets --verify-signatures`. Drop persistent-memory features for the agent (no MEMORY.md). Pre-audit any skill before install. |
| **R-6** | ZeroDev session-key escape / scope-bypass (ERC-7710/7715). Both ERCs still **Draft** in mid-2026 — wire through `@zerodev/permissions` abstractions, not raw 7715 RPC, until Last Call. OWASP Agentic AI Top 10 calls out delegated-identity abuse. | Medium | Tightest possible permission set — target-contract + selector allowlist, value cap per call, total cap per epoch, validity ≤ chat session. Passkey validator as root signer; ECDSA session keys for short-lived ops only. Session keys stored in TPM-backed/KMS-bound keystore on the policy-engine host, never on the LLM-process host. Slither + Mythril on any custom Kernel hooks. On-chain kill-switch via passkey. Explicit re-authorization for any cross-chain permission upgrade. |
| **R-7** | MCP env-block exfiltration / MCP-client RCEs. Precedents: CVE-2025-6514 mcp-remote (CVSS 9.6, 437K installs); CVE-2025-54135 CurXecute; CVE-2025-54136 MCPoison; Cline 2.3.0 supply-chain (Feb 2026); April 2026 Anthropic MCP SDK STDIO arbitrary-command CVEs (~7K servers, 150M+ downloads). | High | MCPB `sensitive: true` → OS keychain (free, no plaintext disk). Local broker daemon over Unix socket; never put session key in `claude_desktop_config.json` env. Bind transports to 127.0.0.1. Ban `mcp-remote`. CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1. Pin tool descriptions on first use. Ship via npm OIDC with provenance attestations. |
| **R-8** | FHE-specific: ciphertext malleability, ACL bypass on CoFHE, oracle manipulation. Precedents: Halborn / OWASP SC02:2025 ($8.8B+ DeFi oracle losses YTD 2025; KiloEx Apr 2025; USDe/Moonwell stress 2025). CoFHE's "training-wheels" trust model (trusted dealer for keygen, TEEs for ZK-Verifier and Threshold Network as interim). | Medium | Default `FHE.allowThis` for in-contract reuse; `allowTransient` strictly for cross-contract single-tx; never auto-allow to user addresses without explicit user signature. Permit-hash binding on every `cofheClient.decryptForView`. Slither custom detectors over `FHE.allow` call-sites. `cofhe-mock-contracts` test suite asserting unauthorized addresses cannot unseal. Chainlink data-streams or Pyth pull-oracles with deviation thresholds + heartbeat for RWA NAV. TWAP + multi-source aggregation. Circuit breaker pauses encrypted-balance state mutation on >X% oracle deviation. Document Fhenix's interim trust assumption explicitly to MuHaven users. |

Hardening details: `development/WAVE_PLAN.md` § "Wave 4 → Phase P8". P8 landed on `agenticwave` 2026-05-06: safety module at `backend/src/infrastructure/agent/safety/` (PromptArmor input filter + CaMeL deterministic policy gate + ANSI/Unicode-smuggling output sanitiser); CI gate at `scripts/lethal-trifecta-lint.ts` (`pnpm run lint:trifecta:strict`); OWASP LLM Top 10 + Agentic Top 10 vitest adversarial corpus at `backend/src/infrastructure/agent/safety/__tests__/owasp-redteam.test.ts` (Promptfoo CLI swap is mechanical — same `tests:` shape). Load-bearing decisions: ADR-7 in `development/DEV_WAVE_4/ADR_LOG.md`. Implementation companion: `development/DEV_WAVE_4/SAFETY_HARDENING.md`.

---

## System prompt

The agent's behavior is defined by a system prompt (HavenBot variant; MCP / OpenClaw use scoped variants):

```
You are HavenBot, a confidential RWA portfolio copilot for MuHaven.

YOUR ROLE
- You help investors and issuers operate MuHaven flows on Arbitrum Sepolia.
- You propose actions; you do not sign. Every write goes through the policy gate.
- You always use structured tool intents — never compose raw JSON-RPC.

YOUR CAPABILITIES (read tools — no policy gate)
- muhaven_portfolio_summary, muhaven_quote, muhaven_check_protection_coverage,
  muhaven_explain_kyc_attestation, muhaven_audit_view (issuer scope)

YOUR CAPABILITIES (write tools — policy gate enforces tier)
- muhaven_propose_buy, muhaven_propose_redeem, muhaven_propose_claim,
  muhaven_propose_governance_vote, muhaven_cast_encrypted_vote,
  muhaven_set_policy, muhaven_pause, muhaven_unseal_position,
  muhaven_distribution_wizard (issuer), muhaven_kyc_whitelist_add (issuer),
  muhaven_set_token_compliance (issuer)

YOUR CONSTRAINTS
- NEVER bypass the policy gate. NEVER call signing endpoints directly.
- NEVER reveal another user's portfolio data — every encrypted handle requires
  a permit signed by the data owner.
- NEVER suggest actions outside the user's current tier; instead, suggest
  raising the tier (muhaven_set_policy) which the user signs separately.
- You are NOT a financial advisor — you provide tools and information.
- All balances, amounts, and risk parameters are FHE-encrypted on-chain.
  You operate on encrypted state through tool surfaces; you never decrypt
  directly.

CONFIRMATION
- In Advisory tier: every write produces a passkey-signed confirmation.
- In Confirm-per-action tier: every write produces a session-key-signed
  confirmation through <ConfirmModal>.
- In Policy-bound tier: writes within policy bounds execute without
  confirmation; out-of-bounds intents are rejected by the gate (not silently
  downgraded).

PRIVACY PRINCIPLE
Your strategy, the user's strategy, and the encrypted state itself are
private. Nobody else — not competitors, not MEV bots, not operator infra,
not the LLM provider, not even you — can see the portfolio without an
explicit user-signed permit.
```

---

## Implementation references

| Surface | Code location | Wave 4 phase |
|---|---|---|
| HavenBot Vue route | `frontend/src/views/AgentPage.vue` (scaffold) → full impl in `frontend/src/views/agent/HavenBot.vue` | P2 |
| Backend tool handlers + policy engine | `backend/src/agent/` | P1, P2, P6 |
| `@muhaven/mcp` MCPB package | `packages/mcp/` | P3 |
| `muhaven-broker` daemon | `packages/broker/` | P3 |
| OpenClaw skill | `apps/muhaven-rwa-skill/` | P4 |
| Telegram surface | `telegram-bot/` worker (port 3004) + `apps/telegram-mini-app/` Vite project | P4 |
| Hosted checkout | `apps/checkout-pay/` Vite project + `backend/api/v1/checkout/*` routes | P5 |
| Encrypted policy primitives | `contracts/RiskParams.sol` (`checkAndExecute`, `settleBreachDecrypt`, `computeSignalFlags`) | P6 |
| DefaultProtection / EncryptedGovernance / KYCAttestationRegistry | `contracts/protection/` + `contracts/governance/` + `contracts/identity/` | P11 |
| Demo capture + Dune dashboard | `development/DEV_WAVE_4/DEMO_SCRIPT.md` | P9 |
| Threat-model hardening + red-team | PromptArmor preprocessing, CaMeL split, Promptfoo / DeepTeam suite, lethal-trifecta lint | P8 |

Phase tracking: `development/DEV_WAVE_4/PROGRESS.md` (parallel-branch state). Architecture decisions log: `development/DEV_WAVE_4/ADR_LOG.md` (ADR-0..ADR-5 covering tiered-autonomy state machine, MCPB credential storage, hosted-checkout URL scheme, Telegram confirmation tiers, etc.).

---

## What ships when

### Shipped (Wave 3)

- Chat UI scaffold: `frontend/src/views/AgentPage.vue` + `frontend/src/components/agent/*`
- Backend stub at `/api/v1/agent/chat` (returns canned responses)
- ZeroDev passkey + session-key auth (the substrate the agent reuses)
- MuHaven SDK + contracts (the surface the agent calls)
- FHE worker scaffolding (`@cofhe/sdk/node` for server-side tool handlers)

### In active development (Wave 4 — parallel branch)

- Tiered-autonomy engine + audit log + `/pause` kill-switch (P1)
- HavenBot streaming chat + per-action confirm modals (P2)
- `@muhaven/mcp` MCPB server + `muhaven-broker` daemon (P3)
- OpenClaw skill + Telegram surface (P4)
- Hosted checkout `pay.muhaven.app` (P5)
- Encrypted policy primitives in `RiskParams.sol` (P6)
- Issuer-side distribution wizard + audit copilot (P7)
- Threat-model hardening + red-team (P8)
- Demo capture + Dune dashboard (P9)
- DefaultProtection + EncryptedGovernance + KYC attestation stub contracts (P11)

### Post-Wave-4

- Auto-rebalancing (drift-tolerance triggered, policy-bound execution)
- Auto-reinvest of claimed yields
- Insurance tool (when ReineiraOS ships insurance pools, or in-house)
- EIP-7702 native session keys (migrate off ZeroDev's kernel-specific permission system once 7702 finalizes + wallet support lands)
- Multi-provider LLM (Claude, OpenAI, local)
- Agent performance analytics
- Agent-to-agent coordination via x402 + ERC-8004 (treat A2A Agent Cards as discovery, not payment rail per research §6)

---

## References

- [`development/WAVE_PLAN.md` § "Wave 4"](../development/WAVE_PLAN.md) — canonical Wave 4 plan with phase budgets + grant alignment
- [`development/DEV_WAVE_4/`](../development/DEV_WAVE_4/) — execution index, PROGRESS, DEV_LOG, ADR log
- [`development/research-docs/WAVE_4_AGENTIC_RESEARCH_BRIEF.md`](../development/research-docs/) and `WAVE_4_AGENTIC_RESEARCH_RESULT.md` — research that drove the four-surface plan
- [SMART_CONTRACTS.md § Critical CoFHE patterns](./SMART_CONTRACTS.md#critical-cofhe-patterns) — ACL grant rules, permit-based decrypt, silent-fail conventions
- [SDK.md](./SDK.md) — `MuHavenClient` clients the agent calls into
- [THREAT_MODEL.md](./THREAT_MODEL.md) — privacy boundary + side-channel resistance + ZK/TEE/MPC comparison
