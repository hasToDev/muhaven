---
title: Status & limits
description: What ships now, what's deferred, what to expect from each surface.
---

# Status & limits

A reality-check on what each surface does today, what's wired-but-deferred, and what's explicitly out of scope. This page is the single source of truth for "should I expect feature X to work?"

Last verified against Wave 4 closeout (2026-05-13).

## At a glance

| Surface | Status | Notes |
|---|---|---|
| HavenBot dashboard | ✅ Live | 17 tools; Gemini LLM today (swap to Claude in Wave 5) |
| `@muhaven/mcp` | ✅ Live | Published to npm `@muhaven/mcp@0.1.2` with OIDC + Sigstore provenance |
| OpenClaw skill | ✅ Live | `muhaven-rwa-skill@0.1.2` on ClawHub; rehearsal release `muhaven-rwa-skill-rehearsal@0.1.0-rc.1` |
| Telegram bot | ✅ Live | `@muhaven_bot` (prod) + `@muhaven_stage_bot` (stage) |
| Hosted Checkout | ✅ Live | `muhaven.app/pay` — passkey ceremony (P1) on prod since 2026-05-13 |
| Tiered autonomy engine | ✅ Live | Advisory / Confirm-per-action / Policy-bound / Paused |
| Audit log | ✅ Live | Append-only `agent_audit_events` |
| `/pause` kill-switch | ✅ Live | Global across all surfaces |
| Public metrics page | ✅ Live | `https://api.muhaven.app/api/v1/public/metrics` (unauthenticated) |
| P11 contracts | ✅ Live | DefaultProtection + EncryptedGovernance + KYC stubs deployed on Arb Sepolia stage + prod |

## What's wired but deferred to Wave 5

### Frontend runners

The backend dispatcher accepts these tool calls and emits valid ActionDescriptors, but the in-modal ceremony to execute them hasn't landed:

- **`position.rebalance`** — multicall ceremony deferred; ConfirmModal returns `'deferred'` with a redirect to manual rebalance.
- **`governance.cast_vote`** — frontend encrypt-vote ceremony pending the cofhe SDK helper; ConfirmModal returns `'deferred'`.

### MCP enhancements

- **Cross-user permit-gated audit access** — wire shape pinned in ADR-8 §D3; backend ready, frontend ceremony in Wave 5.
- **Multi-turn LLM tool loop** — current `ChatLlmService.runGeminiLoop` is single-turn; multi-turn (reason about tool result → propose follow-up) is Wave 5.
- **JWT auto-refresh on SSE 401** — chat stream raw-fetch path doesn't yet retry on JWT expiry; Wave 5 lifts the refresh logic into SSE.
- **Multi-replica SSE** — in-process today; needs Redis pub/sub for horizontal scale.
- **MCPB host-store distribution** — pending Anthropic's third-party publisher timeline.

### Hosted Checkout

- **P2-P4 buyer-side** — USDC funding poll (P2), real wrap+approve+buy UserOp (P3), `Settled` indexer event (P4). Code-only commits on `agenticwave`; subsequent prod cutovers fast-forward + redeploy.
- **Recurring billing / subscriptions** — out of Wave 4 scope; possible Wave 5+.
- **Multi-buyer checkout** — single-use today; Wave 5+ may add shared-cart.
- **Real WebAuthn for tier-3 passkey deeplink** — Wave 4 ships a `passkeyAssertion: 'wave4-stub'` placeholder accepted by the backend; full WebAuthn server-side verify lands in Wave 5 (purely additive, wire shape stable).

### Issuer

- **KYC bulk import** — Wave 4 ships one-at-a-time; Wave 5 may add CSV import.
- **Issuer onboarding KYB review** — Wave 4 auto-approves in dev mode (`devMode=true` on `MuHavenIdentityRegistry`). Production review path lands with `disableDevModeForever()` once production KYC partners are wired.

### Privacy

- **Wrap-to-mhUSDC deposit-size leak mitigation** — Wave 4 leaks deposit size at wrap. Wave 5 mitigations: batching, delays, CCTP.
- **Audit-log redaction of confirm_tokens** — encrypted vote confirm-token cleartext bounded-leaks for 5-min TTL; Wave 5 auto-redacts on commit.
- **HavenBot "keep chat local-only" mode** — chat history is server-managed today; Wave 5 may add a local-only mode.

## Out of scope (deferred / cut)

These were considered and explicitly pruned from Wave 4:

- Auto-claim cron as a separate surface (auto-claim is reachable via Policy-bound + `auto_claim: true` config).
- Default-detection auto-draft governance.
- Burner-investor mode.
- Stellar / MoneyGram cash-out placeholder.
- Dedicated issuer Telegram bot.
- NAV digest as a separate notification surface.
- `@muhaven/cli` + `muhaven.json` (saved ~12h; can return Wave 5+ if demanded).
- Encrypted signals on every surface (encrypted signals via `RiskParams.computeSignalFlags` are read-side only today).
- A2A as payment rail (kept as discovery via `.well-known/agent.json`; payment rail stays x402-compatible).
- ERC-5564 stealth recipients.

## Wave 5+ candidates (informative — no commitments)

- **EIP-7702 native session keys** (when wallet support lands).
- **Multi-provider LLM** (Claude, OpenAI, local — beyond the Wave 5 Gemini→Claude swap).
- **Agent performance analytics**.
- **Agent-to-agent coordination via x402 + ERC-8004**.
- **Insurance pool integration** (when ReineiraOS ships pools, or in-house).
- **Multi-passkey rebind wizard** in dashboard.
- **Real `ebool` signal flags** from `RiskParams.computeSignalFlags` on portfolio_summary (today server-derived heuristics return null for <2 positions).

## Networks

| Network | Status | Notes |
|---|---|---|
| Arbitrum Sepolia (testnet) | ✅ Production | All contracts deployed; faucet for mhUSDC; full feature parity |
| Arbitrum One (mainnet) | 🟡 Rolling out | Contracts deployed; on-ramp swap to Sardine / Coinbase Onramp / MoonPay in Wave 5 |

## Test coverage at Wave 4 close

| Test suite | Cases |
|---|---|
| Backend vitest | 857 |
| `@muhaven/mcp` vitest | 94 |
| `muhaven-rwa-skill` vitest | 15 |
| Telegram bot vitest | 26 |
| Hardhat contract tests | 807 |
| Playwright E2E | 23 active + 4 skip |
| **Total automated checks** | **~1,832** |

## Service status

For real-time status, check the **public metrics endpoint**:

```bash
curl https://api.muhaven.app/api/v1/public/metrics
```

Returns:
- Backend / DB / indexer / FHE worker / NAV worker health.
- Aggregate token addresses + day-bucketed event counts.
- Plaintext oracle NAVs.

The endpoint is unauthenticated by design — the privacy invariant ensures it never leaks per-investor data.

## How to file an issue

- **GitHub issue:** [github.com/hasToDev/muhaven/issues](https://github.com/hasToDev/muhaven/issues).
- **Telegram support:** `@muhaven_bot` → `/help` → `Contact support`.
- **Security:** see [`docs/THREAT_MODEL.md`](https://github.com/hasToDev/muhaven/blob/master/docs/THREAT_MODEL.md) §"Reporting a vulnerability".

## Where next

- [Tool catalog](/reference/tool-catalog) — every tool side by side.
- [Tier matrix](/reference/tier-matrix) — what runs in which tier.
- [Glossary](/reference/glossary) — terms.
