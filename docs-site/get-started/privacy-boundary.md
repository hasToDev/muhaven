---
title: Privacy boundary
description: Who sees what — operator, LLM, agent, you, the chain.
---

# Privacy boundary

MuHaven encrypts balances end-to-end with Fully Homomorphic Encryption (Fhenix CoFHE). But "end-to-end" is fuzzy — different surfaces have different visibility. This page is the single source of truth on **who sees what**.

## The five observers

| Observer | What they see |
|---|---|
| **The chain** (Arbitrum) | Encrypted handles (`euint128`, `euint64`). Public addresses. Public NAVs. Aggregate event counts. |
| **The operator** (MuHaven's backend) | Aggregate event counts. Issuer KYB metadata. Audit log rows. Public NAVs and yields. **Never** cleartext balances. |
| **The LLM** (HavenBot's Gemini / your MCP host's Claude / etc.) | The structured-tool-call inputs and outputs the backend chooses to return. Encrypted-handle stubs, **never** cleartext. |
| **The agent** (the tool runner) | Plaintext for the tool calls you authorized. Decrypted previews assembled in your browser via local permits. |
| **You** | Everything you ask for. Your encrypted balances unsealed locally via `decryptForView` + permit. |

## Where the encryption actually lives

**Encrypted on-chain (FHE ciphertext):**

- Per-investor token balances (`MuHavenToken` `_balances`).
- Per-investor yield-claim amounts (in `MuHavenEscrow` redeemed flag + payout handle).
- Risk-parameter thresholds (`RiskParams.sol` `_maxDrawdown`, `_dailySpent`, `_maxDailySpend`).
- Encrypted votes (`EncryptedGovernance.castVote`).

**Plaintext on-chain (public):**

- Wallet addresses.
- Token NAVs (deviation-gated oracle writes by the issuer).
- KYC whitelist membership (boolean per address).
- Aggregate token addresses and event topics.

**Plaintext on the operator's backend:**

- Audit log rows (one per agent action) — surface, tool, timestamp, outcome.
- Issuer onboarding metadata (legal name, jurisdiction).
- HavenBot chat history (server-managed; you can clear it).
- Aggregate counts that drive the public metrics page.

**Plaintext in your browser only:**

- The decrypted preview you see in ConfirmModal before signing.
- Any `decryptForView(handle).withPermit().execute()` result.
- Your passkey assertion at sign-in.

## What "the operator never sees cleartext balances" means

The MuHaven backend handles:

- Routing your tool calls to the right contract / SDK method.
- Stamping audit log rows.
- Writing public NAVs as the issuer.
- Running the policy-engine cron tick (which uses *encrypted* inputs end-to-end). This is the Policy-bound design; the encrypted-threshold engine is built but disabled in every deployment today, so this tick does not auto-sign.

It does **not** decrypt FHE handles. The FHE decrypt pipeline is:

1. You hold a permit signed by your MuHaven wallet (`cofheClient.getOrCreateSelfPermit()`).
2. Your browser calls `cofheClient.decryptForView(handle).withPermit().execute()`.
3. The CoFHE threshold network checks the permit's ACL on-chain, returns cleartext **to you**.
4. The backend is not involved in this path.

There's one narrow exception in the Policy-bound design: the policy-engine breach path would emit a one-time `decryptForTx` *of the breach event itself* so a `RiskBreach` can be settled on-chain. The breach event surfaces "your tier auto-paused; here's a generic reason code"; it does **not** decrypt the underlying balance. (This breach path is part of the disabled Policy-bound engine — it is present in the contracts but not driven in any deployment today.)

## What the LLM sees

This depends on which surface:

| Surface | LLM model | LLM sees |
|---|---|---|
| **HavenBot** | Google Gemini | The chat transcript + structured tool inputs/outputs returned by the backend. **Never** raw FHE handles. |
| **`@muhaven/mcp`** | Whatever you installed (Claude / etc.) | Same as HavenBot: the JSON the MCP tools return. |
| **OpenClaw + Telegram** | No LLM at the bot edge — Telegram messages are deterministic templates | The bot sees your Telegram chat ID + the inline button you tapped. No LLM exposure. |
| **Hosted Checkout** | No LLM | The buyer sees a deterministic checkout page. |

In every case, the LLM-side context is a **window into the backend's response**, not a window into your encrypted state. The MCP server in particular **never** decrypts — it returns aggregates and structured envelopes.

::: tip Read tools are intentionally non-auditing
We don't log every "user looked at portfolio" call. Only **propose** and **commit** events emit audit rows. Read-side privacy is the floor; forensic completeness for state-changing actions is the wall.
:::

## What the policy gate sees

The policy gate runs **deterministic** code — no LLM in the signing path. It sees:

- The structured tool intent emitted by the LLM (a JSON object with strict-enum fields).
- Your current tier and session-key scope.
- The encrypted threshold check via `RiskParams.checkAndExecute(eAmount, action)`.

It does **not** see cleartext amounts (the FHE check is on ciphertext). It rejects intents that don't match its allowlist; rejected intents never reach a signer.

This is the **CaMeL planner/action split** — the LLM plans, the gate disposes. A jailbroken LLM cannot exfiltrate value because the gate is deterministic code and does not consult the LLM about whether to sign.

## What's leaked at the edges

No system is leakage-free. Two known side-channels worth being aware of:

1. **Wrap-to-mhUSDC deposit size** leaks at the moment of wrap to a chain observer.
2. **Decrypt-event timing** for breach-path `decryptForTx` calls would correlate decrypt frequency to swap frequency if not for the **branchless `FHE.select` hot path** — decrypts are kept off the policy hot path precisely to avoid this.

## Comparison: ZK vs TEE vs MPC vs FHE

MuHaven chose FHE; here's the trade-space in one paragraph.

- **ZK** (zero-knowledge): great for proving statements, awkward for stateful balances. State of the art (Aztec, Aleo) requires application-specific circuits.
- **TEE** (trusted execution): cheap per-op, requires trust in the silicon vendor (Intel SGX, AMD SEV). Side-channel attacks (CacheBleed, etc.) are an active research area.
- **MPC** (multi-party computation): no single-party trust, but high coordination cost and slow for general computation.
- **FHE**: computation on ciphertext directly; no per-op trust assumption; slowest of the four today but improving fast (Fhenix CoFHE TFHE-rs target: 50× per quarter for the next two years).

MuHaven leans on FHE because the **stateful encrypted-balance** primitive is exactly what FHE is uniquely good at, and the side-channel surface is smaller than TEE's.

## Where to read more

- [`docs/THREAT_MODEL.md`](https://github.com/hasToDev/muhaven/blob/master/docs/THREAT_MODEL.md) — full project-level threat model.
- [`docs/AGENT_DESIGN.md`](https://github.com/hasToDev/muhaven/blob/master/docs/AGENT_DESIGN.md) — agent-layer architecture.
- [Tiered autonomy](/policy/tiered-autonomy) — how the policy gate enforces what the agent can do.
