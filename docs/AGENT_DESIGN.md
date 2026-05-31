# MuHaven — AI Agent Design

> Architecture for the MuHaven agentic layer. Multiple surfaces, tiered autonomy, hybrid policy storage. Status, threat model, and rollout in one document.

---

## Status

**Live on prod (`muhaven.app` / `api.muhaven.app`).** The agentic layer is shipped and running. Investors and issuers drive every flow either directly from the Vue dashboard or through one of the live agentic surfaces. The shared substrate is the MuHaven SDK + a deterministic `@zerodev/permissions` policy gate.

### Surface status

| Surface | Status | Notes |
|---|---|---|
| **HavenBot** — in-dashboard chat (`/agent`) | **Live on prod** | Google Gemini planner → deterministic policy gate → `<ConfirmModal>` → passkey-bound ZeroDev kernel. With a live **Scoped** session key armed, it auto-executes buy / sell / rebalance with **no per-action passkey** (zero-prompt). |
| **`@muhaven/mcp`** — MCP server | **Live on npm** (`@muhaven/mcp@0.6.2`) | Claude Desktop / Code / Cursor. Companion `muhaven-broker` daemon (OS-keychain creds, Unix-socket signing). Released via signed git tag `mcp-vX.Y.Z`, never `npm publish`. |
| **Telegram bot** | **Live** | Includes a `/revoke_session` phone kill-switch (revokes active Scoped sessions from the phone). |
| **OpenClaw skill** (`muhaven-rwa-skill`) | **In development** | Planned ClawHub publish via Sigstore + GitHub OIDC; bundles a subset of the MCP toolset. Not prod-live. |
| **Hosted checkout** (`muhaven.app/pay`) | **In development** | Stripe-pattern URL + AES-256-GCM enc_payload + HMAC-SHA256 webhooks + ZeroDev passkey ceremony. Not prod-live. |

Each surface reaches the same SDK + policy gate. A **tiered-autonomy state machine** (Advisory / Confirm-per-action / Scoped autonomy) backs every surface; the `pause` kill-switch uninstalls the active session validator in ~1 block.

**Recently shipped and live:** auto-reinvest (claim → buy) via the keyless `muhaven-reinvest` runner; in-app auto-rebalance (one atomic UserOp, sells-before-buys) via an in-tab Scoped session; direct mhUSDC → USDC exit; send cleartext USDC.

> **Staging / preview-only contracts.** `EncryptedGovernance`, `DefaultProtection`, `KYCAttestationRegistry` + `MuHavenKYCVerifier`, and `RiskParams` are deployed on staging/preview, not prod. The corresponding MCP tools (`governance.propose` / `governance.cast_vote`, `read.protection_coverage`, `read.kyc_attestation`) exist in the catalog but back staging contracts. The encrypted-risk-params policy hot path is a designed primitive on staging/preview — the autonomy engine's risk-breach auto-pause is **not yet driven in prod**.

---

## What the agent does

A regular LLM answers questions. An agent **does things**.

When you ask ChatGPT "what's the best RWA yield?", it answers. When you tell HavenBot "buy $500 of CETES from a stablecoin position", it checks current rates, pulls the deviation-gated NAV, recommends an allocation, gets your approval (or, on an armed Scoped session, executes with no per-action prompt), signs the UserOp through your kernel + scoped session key, and settles atomically through `MuHavenSubscription.purchase`. Encrypted balances never leave your local decrypt permit.

Three components:

1. **Brain.** An LLM (Google Gemini today; one-file swap to Claude via Vercel AI SDK) that understands natural language and produces structured tool-call intents. The LLM never holds keys and never directly invokes a wallet method.
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
│  Policy gate     │ ── tier check (Advisory/Confirm/Scoped)
│  (deterministic) │ ── @zerodev/permissions validator scope
│                  │ ── RiskParams encrypted threshold check (staging/preview)
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

Prompt-injection attempts that would have triggered an off-policy tool call are rejected by the policy gate before the LLM's intent reaches a signer. The CaMeL planner/action split keeps the planner LLM out of the signing path entirely.

---

## Surfaces

Each surface is a different way to reach the same SDK + policy gate. (See `development/WAVE_PLAN.md` for the architecture-decisions table.)

### HavenBot (in-dashboard copilot) — **live on prod**

- Where: `/agent` route in the Vue 3 dashboard.
- Stack: Google Gemini planner (one-file swap to Claude via Vercel AI SDK when the user adds a Claude key); SSE streaming chat at `/api/v1/agent/chat/stream`; per-action `<ConfirmModal>` component with FHE-decrypted preview (`cofheClient.decryptForView(handle).withPermit().execute()`).
- **Scoped autonomy:** when a live Scoped session key is armed, HavenBot auto-executes buy / sell / rebalance with **no per-action passkey prompt** (zero-prompt). Without a Scoped session it falls back to Confirm-per-action.
- Onboarding flow: passkey → KYC → first-buy in <6 minutes (Wealthfront-style limits paragraph; "sealed-glass-envelope" copy).
- Tool surface (investor-facing): portfolio read, quote/yields, buy, sell, claim, rebalance, set-tier, pause, position unseal.
- Tool surface (issuer-facing): `distribute_yield`, `kyc_add`, `kyc_remove`, `unpause_token`, `audit_query`. All propose tools gate on `role === 'issuer' && issuerStatus === 'approved'` AND `token.issuerAddress === ctx.walletAddress` (token-issuer-of-record).
- Rebalance (in-app, targets-driven) has TWO modes: (a) called with NO `legs` ("rebalance toward my targets") → backend returns an `open_rebalance_composer` directive (the server can't read encrypted balances); the dashboard computes the drift legs under the user's decrypt permit (balances × public NAV vs. saved targets), then re-calls the tool WITH explicit legs to mint the hash-bound confirm token. (b) called WITH `legs` → the standard hash-bound multi-leg descriptor. Either way, all legs settle in ONE silent atomic UserOp (sells before buys) via the in-tab Scoped session key — see THREAT_MODEL §5.2. The LLM must NEVER invent leg amounts.

### `@muhaven/mcp` MCP server — **live on npm** (`@muhaven/mcp@0.6.2`)

- Format: MCP package with `manifest.json` declaring every env var + binary + endpoint. **All secrets `"sensitive": true` → OS keychain.** No env-block credentials.
- Companion daemon: `muhaven-broker` (Node 20) listening on a Unix socket (named pipe on Windows) with peer-credential ACLs. Holds the session-key private half. MCP calls `signUserOp` over the socket.
- 25 tools (8 read-only). Groups: `muhaven.read.*` (portfolio, yields, distribution, tokens, audit, activity, protection_coverage, kyc_attestation), `muhaven.position.*` (buy, sell, claim, rebalance), `muhaven.cash.*` (wrap, unwrap), `muhaven.policy.*` (set_tier, pause, audit_export, session_key_status), `muhaven.issuer.*` (distribute_yield, kyc_add, kyc_remove, unpause_token, audit_query), `muhaven.governance.*` (propose, cast_vote — staging-backed). `--read-only` flag analogous to `github/github-mcp-server`; only `muhaven.read.*` survives the filter.
- **Autonomous position tools:** when a Scoped session key is armed, `muhaven.position.*` tools execute the on-chain trade **autonomously** inside the `@zerodev/permissions` validators (no per-action passkey). The pre-filled dashboard deep-link is the lower-autonomy **fallback** path, not the only path.
- Hardening: tool-description pinning (`mcp-context-protector` pattern); transports bound to `127.0.0.1`; `mcp-remote` banned; `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` documented in setup.
- Publish: **signed git tag `mcp-vX.Y.Z`** (triggers `mcp-publish.yml` → Sigstore-signed npm publish). Never a manual `npm publish`.
- Installs: Claude Desktop, Cursor, Claude Code.

### Telegram bot — **live**

- Telegram surface with three confirmation tiers:
  - **≤ $200**: inline keyboard preview → confirm
  - **$200 – $5K**: Mini App + 6-digit OTP (mailed via passkey-auth'd webhook)
  - **> $5K**: deep-link to passkey signature in browser. **Caveat:** the >$5K passkey deep-link tier currently uses a `'wave4-stub'` WebAuthn assertion stub; the real `@simplewebauthn` round-trip is planned.
- `/revoke_session` phone kill-switch — revokes the user's active Scoped sessions from the phone (surface-agnostic revoke-all).

### OpenClaw skill (`muhaven-rwa-skill`) — **in development**

- Planned: skill folder published to ClawHub (`SKILL.md` frontmatter, `manifest.json` permissions, `config.json`, bundled MCP server subset), Sigstore signing + GitHub OIDC trusted publishing, two-maintainer release.
- Planned CI: `openclaw skills publish --scan` (VirusTotal multi-engine + Code Insight) + Snyk `mcp-scan`.
- Issuer-side: `.well-known/agent.json` A2A Agent Card for VibeKit / Google ADK discovery (discovery only — A2A is not the payment rail).

### Hosted checkout `muhaven.app/pay` — **in development**

- Hono service deployed on Cloudflare Workers (or Bun); Drizzle/Postgres `checkout_sessions` table.
- URL scheme: `https://muhaven.app/pay/c/<ulid>#k=<base64url(32B)>`. Server-side `enc_payload = AES-256-GCM(plaintext, key=HKDF(k))`; 30-min TTL. **The key never reaches the server** — fragments are not sent in `Referer`, so the server holds ciphertext useless without the key.
- Webhook signing: `MuHaven-Signature: t=<unix>,v1=<HMAC-SHA256(t.body, whsec_…)>` over raw body, 5-min replay window. `Idempotency-Key` header dedupe. SSRF guard on outbound webhook URLs.
- Realtime: in-process SSE channel (replaces Supabase Realtime — avoids leaking session metadata to third-party SaaS).
- ZeroDev passkey ceremony for non-customer buyers: provisions kernel account on first use via `@zerodev/passkey-validator` + `createKernelAccount`. **Passkey RP ID** = `muhaven.app` (prod, eTLD+1) / `stage.muhaven.app` (stage subdomain) so kernels recovered at checkout work in the dashboard.
- Issuer DID/OnchainID resolution to verified label ("You are paying [Issuer Verified]" — Stripe pattern).
- Funding flow: testnet uses faucet redirect. Pluggable `<FundingProvider>` Vue component for a future fiat on-ramp swap (Sardine / Coinbase Onramp / MoonPay).

---

## Tool catalog

The MCP server (`@muhaven/mcp@0.6.2`) exposes **25 tools (8 read-only)**. Each carries strict-enum names, structured-output schemas with `additionalProperties: false`, and runs through the deterministic policy gate before any signing. HavenBot consumes the same surface via Vercel AI SDK tool-call schemas; the MCP namespace is `muhaven.<group>.<tool>`.

### Read (8 — no policy gate, read-only)

| Tool | What it does | Backed by |
|---|---|---|
| `muhaven.read.portfolio` | Encrypted balance preview + signal flags | CoFHE `decryptForView` + permit |
| `muhaven.read.yields` | Cleartext NAV × amount + per-share rate preview | `IPriceOracle.getNAV(token)` + `YieldSnapshot` |
| `muhaven.read.distribution` | Yield-epoch / distribution status | `YieldSnapshot` |
| `muhaven.read.tokens` | RWA token catalog + status | `TokenRegistry` |
| `muhaven.read.audit` | The calling user's tiered-autonomy audit log | `agent_audit_events` table |
| `muhaven.read.activity` | Account activity feed (cash rail + trades + claims) | backend `tax_events` |
| `muhaven.read.protection_coverage` | Public `reserveRateBps` | `DefaultProtection` — **staging-backed** |
| `muhaven.read.kyc_attestation` | Cross-chain KYC attestation read | `KYCAttestationRegistry` — **staging-backed** |

### Position (4)

| Tool | What it does | Backed by |
|---|---|---|
| `muhaven.position.buy` | Atomic purchase. With a Scoped session armed, executes autonomously; otherwise returns a dashboard deep-link / confirm. | `SubscriptionClient.purchase` |
| `muhaven.position.sell` | Instant redeem with auto-escalate to queue on cap overflow | `SubscriptionClient.redeem` |
| `muhaven.position.claim` | Pull yield for a finalized epoch | `YieldSnapshotClient.claimYield` |
| `muhaven.position.rebalance` | Targets-driven multi-leg rebalance (one atomic UserOp, sells before buys) | `SubscriptionClient` (purchase/redeem) |

### Cash (2)

| Tool | What it does | Backed by |
|---|---|---|
| `muhaven.cash.wrap` | USDC → mhUSDC | `StableClient.wrapUsdc` |
| `muhaven.cash.unwrap` | mhUSDC → USDC (two-phase async exit) | `StableClient.withdrawToUsdc` → `claimUsdc` |

### Policy (4)

| Tool | What it does | Backed by |
|---|---|---|
| `muhaven.policy.set_tier` | Tiered-autonomy state machine: Advisory / Confirm-per-action / Scoped | `@zerodev/permissions` validators |
| `muhaven.policy.pause` | Single-tx kill-switch — uninstalls active session validator (~1 Arb block) | ZeroDev kernel `uninstallPlugin` |
| `muhaven.policy.audit_export` | Export the user's audit log | `agent_audit_events` table |
| `muhaven.policy.session_key_status` | Inspect the active Scoped session key | `@zerodev/permissions` |

### Issuer (5)

| Tool | What it does | Backed by |
|---|---|---|
| `muhaven.issuer.distribute_yield` | Schedule a yield epoch (open → snapshot → finalize → fund). Backend never sees the encrypted handle — encrypted SDK-side. | `@muhaven/sdk` yield-epoch flow |
| `muhaven.issuer.kyc_add` | Add an investor to the ERC-3643 whitelist. Tier-1 = retail (1 tx); tier-2 = accredited (2 sequential txs). | `ERC3643KYCAdapter` |
| `muhaven.issuer.kyc_remove` | Remove an investor; contract auto-clears tier-2 accredited status. | `ERC3643KYCAdapter.removeFromWhitelist` |
| `muhaven.issuer.unpause_token` | `oracle.setNAV(token, initialNav)` + `tokenRegistry.setPaused(token, false)`, both signed by the **applicant kernel** (production-trajectory shape). Idempotent. | `IssuerControlledOracle.setNAV` + `TokenRegistry.setPaused` |
| `muhaven.issuer.audit_query` | Read the calling issuer's audit log (cursor-paginated, issuer-self, 90-day window). | `agent_audit_events` table |

All issuer propose tools gate on `role === 'issuer' && issuerStatus === 'approved'` AND `token.issuerAddress === ctx.walletAddress` (token-issuer-of-record), and sign as the **issuer kernel** (never the platform deployer).

### Governance (2 — **staging-backed**)

| Tool | What it does | Backed by |
|---|---|---|
| `muhaven.governance.propose` | Open a governance proposal | `EncryptedGovernance` — **staging-backed** |
| `muhaven.governance.cast_vote` | Encrypted ballot via `FHE.select` + async tally | `EncryptedGovernance` — **staging-backed** |

**Multi-tx descriptor shape.** Issuer propose tools return `sdkCall.args.txs[]` — an ordered array of real `(contract, address, fn, args)` tuples. No synthetic function names; the runner branches on `txs.length` and resolves every entry against a real ABI.

**Replay defense.** Every issuer-side `actionPayload` pins `requestedAtSec` (Unix seconds) AND `tool` name into the action hash. Without `requestedAtSec`, an issuer could re-submit the same `(token, amount, label)` confirm token forever within the 5-min TTL. Without `tool`, the post-hoc audit log couldn't distinguish a `kyc_add` commit from a `distribute_yield` commit at the `permit_granted` row level.

**Planned.** A `set_token_compliance(token, modules)` tool for ModularCompliance binding (CountryAllow / MaxHolders / Lockup), and cross-user permit-gated audit (the "compliance officer" wire — wire shape pinned so the upgrade is purely additive: a new `permit` request field; `scopedTo: 'self'` flips to a user-id when a permit is present).

All tool definitions live in `backend/src/agent/tools/*.ts`; HavenBot consumes them via Vercel AI SDK tool-call schemas, MCP exposes them through the MCP tool-list, the planned OpenClaw skill bundles a subset.

---

## Tiered autonomy

The investor chooses a tier; the policy gate enforces it on every intent. Tier selection is itself a `policy.set_tier` call signed by the user's passkey.

### Advisory (default for fresh investors)

- LLM proposes; user signs each action with passkey.
- No session-key delegation; no autonomous automation.
- Used during onboarding (<30 days, <$5K cumulative deposits) per SEC IM-2017-02 + FINRA Reg BI Care Obligation framing.

### Confirm-per-action

- LLM proposes; user confirms with passkey **or** session-key signature within the active session.
- Per-action `<ConfirmModal>` shows the FHE-decrypted preview before signing.
- Default for returning users (≥5 confirmed actions, no breach in last 30 days).

### Scoped (autonomous)

- The user mints a session-key kernel scoped to the MuHaven contract set (e.g. `subscription.purchase`/`redeem`) with per-op caps + TTL. Subsequent buy / sell / rebalance intents execute **autonomously** inside the `@zerodev/permissions` validators — no per-action passkey prompt — for both HavenBot and the MCP position tools.
- The `pause` kill-switch (and the Telegram `/revoke_session` phone kill-switch) uninstalls / revokes the active session validator in ~1 block.
- Available for power users who explicitly arm a Scoped session.

> The encrypted risk-threshold engine (`RiskParams.sol` — `checkAndExecute` / `settleBreachDecrypt`) is a designed primitive deployed on **staging/preview**. The risk-breach auto-pause to Advisory is **not yet driven in prod**; the prod hot path bounds autonomy purely via the on-chain `@zerodev/permissions` envelope (selector allowlist + per-op cap + TTL) plus the kill-switch.

State machine implementation: `backend/src/agent/policy-engine/`. On staging, the breach hot path is: encrypted-input check via `cofhejs.encrypt` → `RiskParams.checkAndExecute(eAmount, action)` → on breach, `decryptForTx` + on-chain `settleBreachDecrypt(handle, cleartext, signature)`.

---

## Hybrid policy storage

> The encrypted-threshold half of this design lives on **staging/preview** (`RiskParams.sol`); it is not a prod-live driver yet. The plaintext rule-shape (the `@zerodev/permissions` validator config) is what bounds autonomy in prod today.

Pure-encrypted-on-chain rules cost 3–8s + ~$0.05–0.20 per check **and** leak decrypt-event timing (correlate decrypt frequency to swap frequency → infer position size). Pure-plaintext rules expose strategy to the operator. The hybrid design splits the difference:

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

Latency-bench result (Arb Sepolia, 10 iters, 100% success rate): `decryptForTx` p50 = 1.22s / p99 = 1.25s; `decryptForView` p50 = 477ms / p99 = 485ms. End-to-end breach commit = ~1.2s TN + ~1.5s `settleBreachDecrypt` Arb tx ≈ 2.5–3s — comfortably under the 3-8s target. Full table: `development/DEV_WAVE_4/LATENCY_BENCH_REPORT.md`.

---

## Wallet model

Earlier drafts proposed a dedicated agent wallet funded with a capped USDC balance. That model was retired in favor of the ZeroDev passkey kernel + session-key system. The agent never holds a private key.

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
    └── Agent delegated actions reuse the same kernel
        ├── Tighter session-key scope when an agent acts on the user's behalf
        │   (per-target selector allowlist, value cap per call, total cap per epoch,
        │    validUntil ≤ chat session)
        ├── Per-action confirmation modal in Confirm-per-action tier
        ├── Zero-prompt autonomous execution on an armed Scoped session
        ├── Deterministic policy gate (CaMeL planner/action split) — LLM's intent
        │   never reaches a signer until validated against on-chain policy
        └── Audit log (WORM, permit-grant events) for every tool call
```

Implementation reference: `frontend/src/providers/zerodev/`, `frontend/src/providers/session-key.ts`, `backend/src/agent/policy-engine/`. Design rationale: `development/DEV_WAVE_3/PROMPT_REDUCTION_PLAN.md`. EIP-7702 native session-key migration stays on the roadmap once wallet support lands.

---

## Auth posture (no third-party IdP, by design)

**Every auth primitive across the agent layer is self-hosted.** Auth0 / Okta / Firebase Auth / Clerk / Magic / Supabase Auth — none of them appear anywhere in the stack. This is a deliberate architectural decision driven by the threat model, not a backlog item awaiting an integration.

| Surface | Auth primitive | Backed by |
|---|---|---|
| Dashboard (`muhaven.app`) | **SIWE (EIP-4361)** → JOSE-signed JWT | ZeroDev passkey kernel (WebAuthn). `backend/src/infrastructure/auth/jwt.service.ts` |
| HavenBot `/agent` chat | Same SIWE JWT + `withScope(['mcp.read.*' \| 'mcp.propose.*'])` | Inherits dashboard auth |
| `@muhaven/mcp` server | **OAuth 2.0 Device Authorization Grant (RFC 8628)** → scoped JWT in OS keychain | `@napi-rs/keyring` + `muhaven-broker` daemon over Unix socket. Self-hosted endpoints under `/api/v1/auth/device/*`. |
| Telegram / OpenClaw | Bot service-secret + Telegram `initData` HMAC-SHA256 + dashboard JWT for >$5K tier (currently a `'wave4-stub'` WebAuthn assertion — real round-trip planned) | All self-verified |
| Hosted checkout (in development) | URL-as-capability (~127-bit sessionId entropy) + AES-256-GCM payload + WebAuthn passkey at first use | Self-hosted, RP-ID pinned to dashboard hostname |

### Why no Auth0 / external IdP

Five reasons, in priority order:

1. **WebAuthn RP-ID pinning is the load-bearing phishing-resistance control.** A phishing site at `muhaven-link.com` literally cannot complete the passkey ceremony because the browser enforces RP-ID match. Routing through an external IdP would either replace the WebAuthn ceremony (kernels become unrecoverable from the dashboard) or layer on top of it (doubling the auth surface for zero security gain).
2. **Trust anchor is wallet-rooted, not identity-provider-rooted.** Investors prove control via SIWE signature; smart-account recoverability flows from passkey-on-device. Adding an IdP creates a confused-deputy hole that the scoped-JWT design was meant to close.
3. **Privacy-boundary forbids operator-side metadata leaks.** R-1 and R-7 say strategy + auth events stay private from operator infra. An external IdP sees every login event for every surface — metadata it monetizes and stores. Self-hosted JWT emits no such signal.
4. **R-7 (MCP env-block exfiltration)** is solved by `@napi-rs/keyring` + the broker daemon, not by an external IdP. External-IdP bearer tokens have identical exfil characteristics — adding one wouldn't have fixed R-7, just relocated the secret.
5. **Cost asymmetry**: external IdPs price ~$0.20/MAU at scale. For a confidential-RWA platform aiming for millions of investors that's real money for zero security gain over self-hosted.

### Where an IdP MIGHT land later

- **Enterprise SSO for issuers** (Okta / Azure AD) if institutional issuers need it. Would NOT replace investor-side passkey/SIWE; would land as an alternate route through `apply-issuer`.
- **OIDC federation for compliance officers** — same shape; future scope for the read-only audit copilot path.

Investor-side SIWE + WebAuthn + scoped JWT + device flow is the floor — adding to it (for issuer SSO) is fine; replacing it (for investor convenience) is not.

---

## Threat model

Agentic-layer risk register. Augments the project-wide register at `development/WAVE_PLAN.md` § "Risk register".

| ID | Risk | Severity | Mitigation |
|---|---|---|---|
| **R-1** | Prompt injection that tricks the agent into permit-granting / unauthorized tx (OWASP LLM01:2025 + Excessive Agency). Precedents: EchoLeak (M365 Copilot 2025), CVE-2025-53773 GitHub Copilot RCE, Cursor+Jira 0-click exfil (Zenity Aug 2025). | High | Willison's lethal-trifecta avoidance + CaMeL planner/action split. All `FHE.allow` / `cofheClient.permit` / ZeroDev permission upgrades pass through deterministic policy gate, not LLM-evaluated. PromptArmor preprocessing layer; structured-output schemas with strict enums. |
| **R-2** | LLM hallucinated tool call (calls `withdraw` when user asked balance). Precedents: April 2026 Claude Code production-DB-deletion incident; OpenClaw inbox-wipe at Meta. | High | Read/write API segregation on separate ZeroDev permissions and separate confirmation surfaces. Two-stage propose-then-execute: agent emits intent JSON, deterministic policy engine validates, then submits. No free-form tool names — strict enums. |
| **R-3** | Replay attacks on confirmation tokens (Telegram callback, MCP tool-call). Precedents: CVE-2025-54136 MCPoison; Forcepoint Telegram-bot replay via predictable `message_id`s; @bissapwned_bot campaign. | Medium | Single-use confirmation tokens, server-side nonce table bound to `(user_id, action_hash, expiry)`. Hash entire `(command, args, env)` tuple — re-approve on any change. ZeroDev session keys with `validUntil ≤ confirmation TTL`. Telegram outbound webhook with `secret_token` header, not `getUpdates` polling. |
| **R-4** | Backend compromise of cron policy engine (npm supply-chain). Precedents: Sept 2025 qix-maintainer phish (chalk/debug/ansi-styles, 2.6B weekly dl, Web3 wallet-drainer payload); Shai-Hulud worm; CVE-2025-55182 React2Shell (DFIR Report Apr 2026, 65K `.env` files exfiltrated). | High | `npm ci` with locked `package-lock.json`; `--ignore-scripts`; Socket / Snyk / Aikido CI gates; reject any package update <7 days in registry; secrets in HashiCorp Vault / Doppler with short TTL (never `.env` files); WAF + outbound-allowlist proxy on the policy engine; rotate ZeroDev paymaster + Fhenix relayer keys on schedule; canary tokens. |
| **R-5** | Supply-chain on agent skills / OpenClaw (ClawHavoc Feb 2026: 1,184+ malicious skills; Atomic macOS Stealer payloads; SOUL.md/MEMORY.md memory-poisoning for delayed execution; CVE-2026-25253 one-click RCE). | High | No third-party skills installed on MuHaven operator infra. Vendor any needed agent skills in-tree, code-review, sign with Sigstore + GitHub OIDC, two-maintainer release. Run inside Docker MCP Toolkit with `--block-network --block-secrets --verify-signatures`. Drop persistent-memory features for the agent (no MEMORY.md). Pre-audit any skill before install. |
| **R-6** | ZeroDev session-key escape / scope-bypass (ERC-7710/7715). Both ERCs still **Draft** in mid-2026 — wire through `@zerodev/permissions` abstractions, not raw 7715 RPC, until Last Call. OWASP Agentic AI Top 10 calls out delegated-identity abuse. | Medium | Tightest possible permission set — target-contract + selector allowlist, value cap per call, total cap per epoch, validity ≤ chat session. Passkey validator as root signer; ECDSA session keys for short-lived ops only. Session keys stored in TPM-backed/KMS-bound keystore on the policy-engine host, never on the LLM-process host. Slither + Mythril on any custom Kernel hooks. On-chain kill-switch via passkey. Explicit re-authorization for any cross-chain permission upgrade. |
| **R-7** | MCP env-block exfiltration / MCP-client RCEs. Precedents: CVE-2025-6514 mcp-remote (CVSS 9.6, 437K installs); CVE-2025-54135 CurXecute; CVE-2025-54136 MCPoison; Cline 2.3.0 supply-chain (Feb 2026); April 2026 Anthropic MCP SDK STDIO arbitrary-command CVEs (~7K servers, 150M+ downloads). | High | MCPB `sensitive: true` → OS keychain (free, no plaintext disk). Local broker daemon over Unix socket; never put session key in `claude_desktop_config.json` env. Bind transports to 127.0.0.1. Ban `mcp-remote`. CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1. Pin tool descriptions on first use. Ship via npm OIDC with provenance attestations. |
| **R-8** | FHE-specific: ciphertext malleability, ACL bypass on CoFHE, oracle manipulation. Precedents: Halborn / OWASP SC02:2025 ($8.8B+ DeFi oracle losses YTD 2025; KiloEx Apr 2025; USDe/Moonwell stress 2025). CoFHE's "training-wheels" trust model (trusted dealer for keygen, TEEs for ZK-Verifier and Threshold Network as interim). | Medium | Default `FHE.allowThis` for in-contract reuse; `allowTransient` strictly for cross-contract single-tx; never auto-allow to user addresses without explicit user signature. Permit-hash binding on every `cofheClient.decryptForView`. Slither custom detectors over `FHE.allow` call-sites. `cofhe-mock-contracts` test suite asserting unauthorized addresses cannot unseal. Chainlink data-streams or Pyth pull-oracles with deviation thresholds + heartbeat for RWA NAV. TWAP + multi-source aggregation. Circuit breaker pauses encrypted-balance state mutation on >X% oracle deviation. Document Fhenix's interim trust assumption explicitly to MuHaven users. |

Hardening details: safety module at `backend/src/infrastructure/agent/safety/` (PromptArmor input filter + CaMeL deterministic policy gate + ANSI/Unicode-smuggling output sanitiser); CI gate at `scripts/lethal-trifecta-lint.ts` (`pnpm run lint:trifecta:strict`); OWASP LLM Top 10 + Agentic Top 10 vitest adversarial corpus at `backend/src/infrastructure/agent/safety/__tests__/owasp-redteam.test.ts` (Promptfoo CLI swap is mechanical — same `tests:` shape). Implementation companion: `development/DEV_WAVE_4/SAFETY_HARDENING.md`.

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
- read.portfolio, read.yields, read.distribution, read.tokens,
  read.activity, read.audit, read.protection_coverage,
  read.kyc_attestation

YOUR CAPABILITIES (write tools — policy gate enforces tier)
- position.buy, position.sell, position.claim, position.rebalance,
  cash.wrap, cash.unwrap, policy.set_tier, policy.pause,
  policy.audit_export, policy.session_key_status,
  governance.propose, governance.cast_vote,
  issuer.distribute_yield, issuer.kyc_add, issuer.kyc_remove,
  issuer.unpause_token, issuer.audit_query

YOUR CONSTRAINTS
- NEVER bypass the policy gate. NEVER call signing endpoints directly.
- NEVER reveal another user's portfolio data — every encrypted handle requires
  a permit signed by the data owner.
- NEVER suggest actions outside the user's current tier; instead, suggest
  raising the tier (policy.set_tier) which the user signs separately.
- You are NOT a financial advisor — you provide tools and information.
- All balances, amounts, and risk parameters are FHE-encrypted on-chain.
  You operate on encrypted state through tool surfaces; you never decrypt
  directly.

CONFIRMATION
- In Advisory tier: every write produces a passkey-signed confirmation.
- In Confirm-per-action tier: every write produces a session-key-signed
  confirmation through <ConfirmModal>.
- In Scoped tier: writes within the session-key envelope execute without
  confirmation (zero-prompt); out-of-envelope intents are rejected by the gate
  (not silently downgraded).

PRIVACY PRINCIPLE
Your strategy, the user's strategy, and the encrypted state itself are
private. Nobody else — not competitors, not MEV bots, not operator infra,
not the LLM provider, not even you — can see the portfolio without an
explicit user-signed permit.
```

---

## Implementation references

| Surface | Code location |
|---|---|
| HavenBot Vue route | `frontend/src/views/AgentPage.vue` → agent components in `frontend/src/components/agent/*` |
| Backend tool handlers + policy engine | `backend/src/agent/` |
| `@muhaven/mcp` package | `packages/mcp/` |
| `muhaven-broker` daemon | `packages/broker/` |
| OpenClaw skill (in development) | `apps/muhaven-rwa-skill/` |
| Telegram surface | `telegram-bot/` worker (port 3004) + `apps/telegram-mini-app/` Vite project |
| Hosted checkout (in development) | `apps/checkout-pay/` Vite project + `backend/api/v1/checkout/*` routes |
| Encrypted policy primitives (staging/preview) | `contracts/RiskParams.sol` (`checkAndExecute`, `settleBreachDecrypt`, `computeSignalFlags`) |
| DefaultProtection / EncryptedGovernance / KYCAttestationRegistry (staging/preview) | `contracts/protection/` + `contracts/governance/` + `contracts/identity/` |
| Threat-model hardening + red-team | PromptArmor preprocessing, CaMeL split, Promptfoo / DeepTeam suite, lethal-trifecta lint |

Architecture decisions log: `development/DEV_WAVE_4/ADR_LOG.md` (tiered-autonomy state machine, hybrid policy split, MCP credential storage, Telegram confirmation tiers, hosted-checkout routing, HavenBot LLM provider, safety hardening, issuer-side namespace + naming).

---

## What ships when

### Live on prod

- HavenBot in-dashboard streaming chat + per-action confirm modals + zero-prompt Scoped autonomy
- `@muhaven/mcp@0.6.2` (25 tools, 8 read-only) + `muhaven-broker` daemon, on npm
- Telegram bot with three confirmation tiers + `/revoke_session` phone kill-switch
- Tiered-autonomy engine (Advisory / Confirm-per-action / Scoped) + audit log + `pause` kill-switch
- Auto-reinvest (claim → buy) via the keyless `muhaven-reinvest` runner
- In-app auto-rebalance (one atomic UserOp, sells-before-buys) via in-tab Scoped session
- Direct mhUSDC → USDC exit; send cleartext USDC
- Threat-model hardening + red-team suite

### On staging / preview only (not prod)

- Encrypted policy primitives in `RiskParams.sol` — risk-breach auto-pause not driven in prod
- DefaultProtection, EncryptedGovernance, KYCAttestationRegistry + MuHavenKYCVerifier — the `governance.*`, `read.protection_coverage`, `read.kyc_attestation` tools exist in the catalog but back these staging contracts

### In development (not prod-live)

- OpenClaw skill (`muhaven-rwa-skill`) → planned ClawHub publish
- Hosted checkout `muhaven.app/pay`
- Real `@simplewebauthn` round-trip for the Telegram >$5K tier (currently a `'wave4-stub'` assertion)

### Roadmap

- Insurance tool (when ReineiraOS ships insurance pools, or in-house)
- EIP-7702 native session keys (migrate off ZeroDev's kernel-specific permission system once 7702 finalizes + wallet support lands)
- Multi-provider LLM (Claude, OpenAI, local)
- Agent performance analytics
- Agent-to-agent coordination via x402 + ERC-8004 (treat A2A Agent Cards as discovery, not payment rail)

---

## References

- [`development/WAVE_PLAN.md`](../development/WAVE_PLAN.md) — canonical plan with phase budgets + grant alignment
- [`development/DEV_WAVE_4/`](../development/DEV_WAVE_4/) — execution index, PROGRESS, DEV_LOG, ADR log
- [`development/research-docs/WAVE_4_AGENTIC_RESEARCH_BRIEF.md`](../development/research-docs/) and `WAVE_4_AGENTIC_RESEARCH_RESULT.md` — research that drove the multi-surface plan
- [SMART_CONTRACTS.md § Critical CoFHE patterns](./SMART_CONTRACTS.md#critical-cofhe-patterns) — ACL grant rules, permit-based decrypt, silent-fail conventions
- [SDK.md](./SDK.md) — `MuHavenClient` clients the agent calls into
- [THREAT_MODEL.md](./THREAT_MODEL.md) — privacy boundary + side-channel resistance + ZK/TEE/MPC comparison
