---
title: Glossary
description: Terms used across MuHaven docs.
---

# Glossary

| Term | Meaning |
|---|---|
| **mhUSDC** | MuHavenStable — confidential USDC wrapper on Arbitrum. The settlement asset for every MuHaven flow. Tickers: `mhUSDC` everywhere user-facing. Internal storage fields may still say `pusdc` for backward compatibility. |
| **RWA** | Real-World Asset. Tokenized representations of off-chain assets (US Treasuries, gold, growth baskets, shipping receivables). MuHaven's RWA tokens are fhERC-20 with FHE-encrypted balances. |
| **fhERC-20** | Fhenix-encrypted ERC-20. Standard ERC-20 surface with `euint128` balances instead of `uint256`. |
| **FHE** | Fully Homomorphic Encryption. Computation on ciphertext without decrypting. Fhenix CoFHE is the implementation MuHaven uses. |
| **CoFHE** | Co-processor Fully Homomorphic Encryption. Fhenix's architecture where encrypted state lives on Arbitrum but heavy FHE compute runs on a sidecar coprocessor + threshold network. |
| **ZeroDev kernel** | An EIP-4337 smart account from [ZeroDev](https://docs.zerodev.app/). Supports passkey signing, session keys, and pluggable validators. MuHaven kernels are passkey-rooted. |
| **Passkey** | A WebAuthn credential — biometric (Touch ID, Windows Hello) or hardware key (YubiKey). The master signer for every MuHaven kernel. |
| **Session key** | A short-lived ECDSA key with narrow scope (target allowlist, selector allowlist, value cap, validUntil). Signs day-to-day actions without re-prompting the passkey. |
| **Tiered autonomy** | MuHaven's four-state machine: Advisory / Confirm-per-action / Policy-bound / Paused. Controls how much the agent can do without asking. |
| **Policy gate** | Deterministic non-LLM code between the LLM and the signing path. Validates every tool intent against your tier + on-chain policy primitives. The LLM proposes; the gate disposes. |
| **CaMeL** | "Capability-aware Multi-LLM" pattern. Planner/action split — the planning LLM never directly invokes signers; a deterministic action layer mediates. |
| **PromptArmor** | Backend preprocessing layer that strips known prompt-injection patterns before the LLM sees user input. |
| **Lethal trifecta** | Simon Willison's framing for the worst-case agentic threat: prompt-injection-prone LLM + tools that move value + access to credentials. MuHaven defends by splitting the credentials (broker pattern) and making the action layer deterministic (CaMeL). |
| **HavenBot** | MuHaven's in-dashboard agent. Streaming chat + per-action ConfirmModal. Lives at `muhaven.app/agent`. |
| **MCP** | [Model Context Protocol](https://modelcontextprotocol.io/). Anthropic's open spec for connecting tools to LLM hosts (Claude Code / Desktop / Cursor). `@muhaven/mcp` is MuHaven's MCP server. |
| **MCPB** | MCP Bundle. The official npm package format for MCP servers — manifest.json declares env vars + binaries + endpoints + tool sensitivity flags. |
| **`muhaven-broker`** | The long-lived per-user daemon shipped with `@muhaven/mcp`. Holds JWT + session key in OS keychain. Speaks Unix socket / named pipe, never TCP. |
| **OpenClaw** | An open standard for agent skills. Skills bundle MCP servers + a manifest declaring permissions. MuHaven publishes `muhaven-rwa-skill` to [ClawHub](https://clawhub.com). |
| **ClawHub** | The central registry for OpenClaw skills. |
| **Three-tier confirmation** | OpenClaw + Telegram's USD-amount-based classifier: ≤$200 inline / $200-$5K Mini-App OTP / >$5K passkey deeplink. Hard-coded; users can't raise. |
| **Hosted Checkout** | `muhaven.app/pay/...` — issuer-minted pay links for non-customer buyers. Fragment-key URL scheme, AES-256-GCM payload, Stripe-pattern webhooks. |
| **Fragment-key URL** | A URL where the encryption key is in the URL fragment (`#k=...`), which browsers never send in `Referer` headers. The server stores ciphertext useless without the key. |
| **`MuHavenSubscription`** | The smart contract that atomically wraps a mhUSDC → RWA-token purchase. Single tx; encrypted output handle. |
| **`MuHavenEscrow`** | Two-phase confidential escrow used for yield distributions. Per-investor escrow created on `startDistribution`; redeemed on `claim`. |
| **`RiskParams.sol`** | Smart contract storing per-user encrypted policy thresholds. Branchless `FHE.select` hot path keeps the policy check off the decrypt timing side-channel. |
| **`InvestorRegistry`** | Paginated registry of MuHavenToken holders. Drives the yield-distribution batching loop. |
| **`YieldDistributor`** | State machine that orchestrates a per-epoch yield distribution: `startDistribution → batchCreate → fundFrom`. |
| **`YieldSnapshot`** | The point-in-time snapshot of holder shares + yields used to compute proportional distribution amounts. |
| **`DefaultProtection`** | P11 contract — opt-in protection pool covering loss-of-principal scenarios on participating RWA tokens. |
| **`EncryptedGovernance`** | P11 contract — FHE-encrypted ballot voting; tally async-decrypted at proposal close. |
| **`KYCAttestationRegistry`** | P11 contract — cross-chain KYC attestation stub. Cleartext jurisdictionHash + attestation signer; encrypted attestation period. |
| **ERC-3643** | The securities token standard. MuHaven RWA tokens have an `ERC3643KYCAdapter` that gates transfers on whitelist membership. |
| **OnchainID** | The identity standard ERC-3643 uses. Wallets bind to OnchainID records that carry claims (KYC tier 1 / tier 2 accredited / jurisdiction). |
| **Permit** | A signed authorization (EIP-2612-style or cofhe-specific) that grants temporary read-access to a specific encrypted handle. MuHaven uses cofhe permits to decrypt your own balances client-side. |
| **`decryptForView`** | The CoFHE client primitive that decrypts an encrypted handle to a cleartext value in your browser, with a permit. Never decrypts server-side. |
| **`decryptForTx`** | The CoFHE primitive that decrypts a handle for on-chain consumption (e.g., breach-path settlement). Settles back to the chain via `publishDecryptResult`. |
| **`agent_audit_events`** | The append-only WORM-style audit table backing every state-mutating action across all four surfaces. |
| **`agent_user_state`** | The Drizzle table tracking each user's current tier + pause state. |
| **`/pause`** | The kill-switch. Uninstalls the session-key validator in ≤1 Arbitrum block (~250ms soft). Global across all surfaces. |
| **Advisory tier** | Every action prompts your passkey via WebAuthn. The default tier for fresh investors. |
| **Confirm-per-action tier** | Session key signs without re-prompting passkey within the 1-hour TTL. ConfirmModal still opens for cleartext preview. |
| **Policy-bound tier** | Cron policy engine signs within your encrypted thresholds without per-action confirmation. Breaches auto-pause. Opt-in. |
| **Paused tier** | All `propose` tools return 423. Read tools work. Resume requires master passkey. |
