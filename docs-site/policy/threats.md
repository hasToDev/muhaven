---
title: Threat model in plain language
description: What can go wrong, and how MuHaven defends against each thing.
---

# Threat model in plain language

The full project-level threat model is at [`docs/THREAT_MODEL.md`](https://github.com/hasToDev/muhaven/blob/master/docs/THREAT_MODEL.md), and the Wave-4-specific hardening companion is at [`development/DEV_WAVE_4/SAFETY_HARDENING.md`](https://github.com/hasToDev/muhaven/blob/master/development/DEV_WAVE_4/SAFETY_HARDENING.md). This page is the plain-English version — what each risk is, who it affects, and how MuHaven defends.

## R-1 — Prompt injection that tricks the agent

**What it is.** An attacker embeds a hostile instruction in a webpage, an email, a Slack message, or any content the LLM might process. The LLM follows the instruction and calls a privileged tool (drains your balance, sends an unauthorized permit, etc.).

**Precedent.** EchoLeak (Microsoft Copilot 2025), CVE-2025-53773 GitHub Copilot RCE, Cursor + Jira 0-click exfil (Zenity Aug 2025).

**Why MuHaven is safer than most.** The **CaMeL planner/action split**: the LLM plans; the **deterministic policy gate** disposes. A malicious instruction can produce any tool intent the LLM wants, but the gate is non-LLM code that:

- Re-validates every intent against your tier + session-key scope.
- Refuses intents that don't match the allowlist.
- Never consults the LLM about whether to sign.

Plus **PromptArmor** input preprocessing strips known injection patterns, and **structured-output schemas** with `additionalProperties: false` lock the tool surface against fabricated fields.

**Residual risk.** A novel injection pattern that PromptArmor doesn't yet match, combined with a tool intent that *happens* to fit your tier scope, could still execute. The mitigation is your audit log + the `/pause` kill-switch — you can detect and stop a misbehaving agent in <1 second.

## R-2 — LLM hallucinated tool call

**What it is.** The LLM, without any attacker, fabricates a tool call the user didn't ask for. ("I'll buy 1000 TBILL1 to help you diversify!" when the user just asked about yields.)

**Precedent.** April 2026 Claude Code production-DB-deletion incident; OpenClaw inbox-wipe at Meta.

**MuHaven defense.** Two-stage propose-then-execute:

1. LLM emits intent JSON.
2. Deterministic policy engine validates against the user's confirmed-actions catalog.
3. Submits to ConfirmModal where the user sees the cleartext preview.
4. User must confirm.

In Advisory + Confirm-per-action tiers, the user is always in the loop. In Policy-bound tier, the engine refuses any intent outside the encrypted thresholds.

**Residual risk.** A user who hits "Confirm" without reading the modal. The cleartext preview is the last-line defense; we make it deliberately clear (large numbers, token symbol, "you'll spend X mhUSDC").

## R-3 — Replay attacks on confirmation tokens

**What it is.** An attacker intercepts a confirmation token (Telegram callback, MCP propose-confirm round-trip) and replays it to settle a different action.

**Precedent.** CVE-2025-54136 MCPoison; Forcepoint Telegram-bot replay; @bissapwned_bot campaign.

**MuHaven defense.**

- **Single-use confirmation tokens** bound to `(user_id, action_hash, expiry)`.
- **Action hash** is `SHA-256(tool || args || requestedAtSec)` — re-validation rejects any payload change.
- **ZeroDev session keys** carry `validUntil ≤ confirmation TTL`.
- **Telegram bot** uses **outbound webhook** with `secret_token` header, not `getUpdates` polling — eliminates one class of replay.

**Residual risk.** A token interception in the 5-min TTL window combined with a same-payload replay. The single-use property bounds the impact to one settlement.

## R-4 — Backend compromise of cron policy engine

**What it is.** An npm supply-chain attack compromises a backend dependency; attacker pivots to the policy-engine host and signs UserOps with the policy-engine's session keys.

**Precedent.** Sept 2025 qix-maintainer phish (chalk/debug/ansi-styles, 2.6B weekly dl, Web3 wallet-drainer payload); Shai-Hulud worm; CVE-2025-55182 React2Shell (DFIR Report Apr 2026, 65K `.env` files exfiltrated).

**MuHaven defense.**

- **`npm ci` with locked `package-lock.json`** in production deploys; no `npm install` floats.
- **`--ignore-scripts`** in CI to defeat install-time payloads.
- **Socket / Snyk / Aikido CI gates** that reject any package update <7 days in registry.
- **Secrets in OS keychain / Vault**, never in `.env` files at rest.
- **Outbound-allowlist proxy** on the policy-engine host — only `api.muhaven.app`, `rpc.zerodev.app`, Arbitrum RPC, and Fhenix coprocessor.
- **Canary tokens** in the secret store that fire alerts if read.

**Residual risk.** A zero-day in the registry verification chain. The mitigation is the **branchless `FHE.select` hot path** in `RiskParams.checkAndExecute` — no decrypt happens unless the encrypted threshold check passes; an attacker can't side-channel the cron-engine into approving an out-of-bounds action.

## R-5 — Supply-chain on agent skills / OpenClaw

**What it is.** A malicious skill on ClawHub installs on user machines, exfils credentials, executes payloads.

**Precedent.** ClawHavoc Feb 2026: 1,184+ malicious skills; Atomic macOS Stealer payloads; SOUL.md / MEMORY.md memory-poisoning for delayed execution; CVE-2026-25253 one-click RCE.

**MuHaven defense.**

- **No third-party skills** installed on MuHaven operator infra. The MuHaven skill (`muhaven-rwa-skill`) is the only first-party skill.
- **Sigstore signing + GitHub OIDC trusted publishing** — the skill's signature is verified against the `hasToDev/muhaven` issuer.
- **Two-maintainer release** workflow gate.
- **Snyk MCP scan** on every PR + a publish-time scan placeholder for VirusTotal.
- **No persistent agent memory** (no MEMORY.md, no SOUL.md) — eliminates the memory-poisoning vector entirely.
- **OpenClaw runtime sandbox** with declared egress allowlist, no filesystem writes, no process spawn.

**Residual risk.** A user who installs an unrelated malicious skill that *also* targets MuHaven's broker socket. The mitigation is **POSIX peer-credentials** on the broker — only processes running as the user can connect to the socket; a malicious skill running under a different uid can't.

## R-6 — ZeroDev session-key escape

**What it is.** A bug in the `@zerodev/permissions` validator stack lets a session-key signer escape the configured scope (sign for a different target contract, send a higher value, etc.).

**Precedent.** ERC-7710 / ERC-7715 still **Draft** in mid-2026 (not Last Call). OWASP Agentic AI Top 10 calls out delegated-identity abuse.

**MuHaven defense.**

- **Tightest possible permission set** — target-contract + selector allowlist, value cap per call, total cap per epoch, validity ≤ chat session.
- **Passkey validator as root signer**; session keys for short-lived ops only.
- **Session keys stored in TPM-backed / KMS-bound keystore** on the policy-engine host, never on the LLM-process host.
- **Slither + Mythril** on any custom Kernel hooks.
- **On-chain kill-switch** via passkey — `/pause` works even if session-key scope is broken.
- **Explicit re-authorization** for any cross-chain permission upgrade.

**Residual risk.** A zero-day in the ZeroDev validator system itself. Wave 5 migrates to **EIP-7702** native session keys once it finalizes — different attack surface, different mitigation set.

## R-7 — MCP env-block exfiltration / MCP-client RCEs

**What it is.** A jailbroken LLM in an MCP host reads the MCP server's env block (which historically contains API keys, JWTs, session keys).

**Precedent.** CVE-2025-6514 mcp-remote (CVSS 9.6, 437K installs); CVE-2025-54135 CurXecute; CVE-2025-54136 MCPoison; Cline 2.3.0 supply-chain (Feb 2026); April 2026 Anthropic MCP SDK STDIO arbitrary-command CVEs (~7K servers, 150M+ downloads).

**MuHaven defense.**

- **MCPB `sensitive: true` → OS keychain** — credentials never appear in env block.
- **`muhaven-broker` daemon** over Unix socket — session key lives in a separate process the LLM can't read.
- **Bind transports to 127.0.0.1** — no remote attack surface.
- **Ban `mcp-remote`** in documentation.
- **`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`** documented in setup.
- **Pin tool descriptions** on first install (`tool-hashes.json`) — server refuses to start on description drift (post-MCPoison).
- **Ship via npm OIDC** with provenance attestations.

**Residual risk.** A jailbroken LLM that can execute arbitrary code on the user's machine could in theory open the Unix socket and call `sign_hash`. But (a) the placeholder intent domain bounds the signature's utility, (b) the broker's `sign_hash` is single-shot per connection, (c) the audit log records every signature, (d) the user's `/pause` is still available.

## R-8 — FHE-specific risks

**What it is.** Ciphertext malleability, ACL bypass on CoFHE, oracle manipulation.

**Precedent.** Halborn / OWASP SC02:2025 ($8.8B+ DeFi oracle losses YTD 2025; KiloEx Apr 2025; USDe/Moonwell stress 2025). CoFHE's "training-wheels" trust model (trusted dealer for keygen, TEEs for ZK-Verifier and Threshold Network as interim).

**MuHaven defense.**

- **Default `FHE.allowThis`** for in-contract reuse; **`allowTransient`** strictly for cross-contract single-tx.
- **Never auto-allow to user addresses** without explicit user signature.
- **Permit-hash binding** on every `cofheClient.decryptForView`.
- **Slither custom detectors** over `FHE.allow` call-sites.
- **`cofhe-mock-contracts` test suite** asserting unauthorized addresses cannot unseal.
- **Chainlink data-streams / Pyth pull-oracles** with deviation thresholds + heartbeat for RWA NAV.
- **TWAP + multi-source aggregation**.
- **Circuit breaker** pauses encrypted-balance state mutation on >X% oracle deviation.
- **Documented Fhenix's interim trust assumption** explicitly to MuHaven users — see [Privacy boundary](/get-started/privacy-boundary).

**Residual risk.** CoFHE's TEE-based interim trust model. Fhenix's roadmap migrates to a fully MPC-based Threshold Network in 2026; until then, the trust model is documented and visible to users.

## What MuHaven is NOT defending against (out of scope)

- **Physical attacks on your device.** A laptop in the hands of a determined attacker can defeat most browser-based security.
- **Hardware-key supply-chain compromise.** If your YubiKey was tampered with before purchase, all bets are off.
- **Browser-extension malware on the user's machine.** Don't run an untrusted extension on the device you use to sign MuHaven actions.
- **Phishing of OTPs delivered via SMS / email** if the user has SIM-swap or email account-takeover exposure. Use a hardware key as your passkey.
- **Government-level legal compulsion** of the operator. MuHaven cannot guarantee that a court order won't compel some operator action; the FHE-encrypted balance property still holds (the operator cannot decrypt), but the operator could pause your account.

The threat model is a living document. Read the full [`docs/THREAT_MODEL.md`](https://github.com/hasToDev/muhaven/blob/master/docs/THREAT_MODEL.md) for the up-to-date register.

## Where next

- [Tiered autonomy](/policy/tiered-autonomy) — your friction-vs-automation knob.
- [Audit log](/policy/audit-log) — the forensic trail.
- [The /pause kill-switch](/policy/pause) — the always-available escape hatch.
