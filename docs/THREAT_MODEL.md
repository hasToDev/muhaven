# MuHaven — Threat Model & Privacy Analysis

> This document defines MuHaven's privacy guarantees, known leakage points, side-channel resistance properties, and comparison with alternative cryptographic approaches.

---

## 1. Privacy Guarantees

MuHaven provides **balance, yield, and risk parameter privacy** for RWA investors. The core guarantee: an observer with full access to on-chain state (block explorer, archive node, subgraph) cannot determine:

- How many tokens any investor holds
- How much yield any investor received
- What risk preferences any investor configured
- Whether a transfer succeeded or failed (silent failure pattern)

### Per-contract guarantees

| Contract | What is private | Mechanism |
|----------|----------------|-----------|
| **MuHavenToken** | Balances, transfer amounts, allowances, total supply (default) | `euint128` storage, `InEuint128` encrypted inputs, `FHE.select` silent failure |
| **YieldDistributor** | Total yield deposited, per-investor yield share, aggregate yield history | `euint128` storage, `FHE.div` for encrypted division, `FHE.allow` per investor |
| **RiskParams** | Max drawdown, min yield, drift tolerance, daily spend cap | `euint64` storage, `FHE.allowSender` for investor self-decrypt |
| **MuHavenVault** | Encrypted token balances (via MuHavenToken) | Delegates to MuHavenToken for all FHE operations |
| **YieldGate** | Eligibility check result (via `Common.isInitialized`) | Binary check — no amounts revealed |

### Access control model

MuHaven uses three distinct FHE access patterns:

1. **Permit-based self-decrypt** (`FHE.allow(ct, investor)`) — The investor decrypts their own data client-side using `cofheClient.decryptForView(ctHash).withPermit().execute()`. No on-chain decryption needed. Used for: balances, yield shares.

2. **Async on-chain decrypt** (`ITaskManager.createDecryptTask`) — Authorized callers request decryption through the CoFHE coprocessor. Result readable after delay via `FHE.getDecryptResultSafe`. Used for: risk params (AI agent reads), yield data (issuer reads).

3. **Public threshold decrypt** (`FHE.allowPublic`) — Makes a ciphertext decryptable by anyone via threshold network. Irreversible. Used for: optional total supply reveal.

---

## 2. Known Leakage Points

### 2.1 Addresses are public

**What leaks:** `msg.sender` in every transaction, `from`/`to` in Transfer events, investor addresses in InvestorRegistry.

**Why it's acceptable:** EVM addresses are inherently public — they appear in transaction calldata regardless of event emissions. Hiding addresses would require account abstraction with relayers (like Z0tz's approach), which is orthogonal to balance privacy. MuHaven's threat model is about **value privacy**, not **identity privacy**. Identity privacy is deferred to wallet-layer solutions.

**Mitigation path:** Integrate with privacy-preserving wallet infrastructure (stealth addresses, account abstraction with paymasters) as a future enhancement.

### 2.2 ERC-20 yield deposit amount

**What leaks:** When an issuer calls `startDistribution(token, totalYield)`, the `safeTransferFrom` is a standard ERC-20 transfer with the amount visible on-chain.

**Why it's acceptable:** This is a transitional limitation. The ERC-20 transfer happens at the system boundary where Privara encrypted payment rails will replace cleartext transfers. MuHaven encrypts the yield amount in contract state immediately after the transfer — our internal accounting is private even though the deposit event is not.

**Mitigation path:** Replace `safeTransferFrom` with Privara SDK encrypted deposit when Privara's code ships.

### 2.3 KYC eligibility boolean

**What leaks:** Whether `kycGate.isEligible(address)` returns true or false (revert on false is observable).

**Why it's acceptable:** This is a binary compliance gate, not a data leak. The KYC gate reveals "is this address whitelisted?" — which is a public-registry check, not private data. The underlying KYC claims (identity documents, accreditation status details) are never on-chain.

### 2.4 Distribution progress counters

**What leaks:** `processedCount` and `escrowsCreated` in YieldDistributor are cleartext.

**Why it's acceptable:** These are operational progress indicators for batch processing. They reveal how many investors have been processed, but `investorCount` is already public (derivable from InvestorRegistry). The counters add no new information beyond "the batch is X% complete."

### 2.5 Transaction timing and frequency

**What leaks:** Block timestamps of all transactions. Frequency of transfers, yield claims, risk param updates.

**Why it's acceptable:** Timing metadata is inherent to all blockchain transactions. Mitigating this requires transaction batching or delayed submission, which adds UX complexity. For the hackathon, we document it as a known tradeoff.

**Mitigation path:** AI agent batches transactions to reduce timing correlation. Randomized submission delays in production.

### 2.6 hasRiskParams boolean

**What leaks:** Whether an investor has configured risk parameters (`_hasParams[investor]` is a cleartext bool).

**Why it's acceptable:** Reveals existence of configuration, not the configuration itself. We deliberately chose a boolean over a cleartext timestamp to minimize metadata leakage (a timestamp would reveal *when* params were set, enabling behavioral profiling).

---

## 3. Side-Channel Resistance

### 3.1 Silent failure pattern (FHE.select)

All balance-dependent operations use `FHE.select()` instead of conditional reverts:

```solidity
// MuHavenToken._transfer()
ebool hasEnough = FHE.gte(_balances[from], amount);
euint128 transferAmount = FHE.select(hasEnough, amount, zero);
```

**Resistance property:** The execution path is identical for sufficient and insufficient balances:
- Same FHE operations executed (gte, select, sub, add)
- Same number of storage writes
- Same gas cost (no early revert)
- Same event emission (`Transfer(from, to)` emitted regardless)

An observer watching gas usage, execution traces, or event logs cannot distinguish a successful transfer from a zero-amount silent failure.

**Where applied:** `MuHavenToken._transfer()`, `MuHavenToken.transferFrom()`, `MuHavenToken.burnFromVault()`

### 3.2 Unified function signatures

Unlike some DeFi protocols that expose direction through function names (e.g., `buyYes()`/`buyNo()`), MuHaven uses unified functions:
- `transfer()` — single function for all transfers (no `transferPrivate`/`transferPublic` split)
- `mint()` — single function for all mints
- `processBatch()` — single function for all yield distribution

Function selector in calldata reveals the *type* of operation (mint, transfer, distribute) but never the *value* or *outcome*.

### 3.3 FHE handle reuse in batch distribution

In `YieldDistributor.processBatch()`, the encrypted per-investor yield handle is reused across all investors in a batch. For equal-split distributions, this is privacy-neutral (all shares are identical). For production proportional distributions, each investor should receive a unique ciphertext to prevent correlation analysis.

---

## 4. Comparison with Alternative Approaches

### Why FHE, not ZK?

| Requirement | ZK Proofs | FHE (Fhenix CoFHE) |
|------------|-----------|---------------------|
| Prove eligibility without revealing data | Yes | Yes |
| Store encrypted balances as persistent on-chain state | **No** — ZK proves transitions, but state must be readable for verification | **Yes** — balances are ciphertext stored on-chain |
| Compute on encrypted values (add, subtract, compare) | **No** — ZK proves a computation happened, cannot perform new computation on hidden state | **Yes** — `FHE.add`, `FHE.sub`, `FHE.gte`, `FHE.div` on ciphertext |
| Yield distribution on encrypted balances | **No** — would need to reveal balances to compute proportional shares | **Yes** — `FHE.div(encTotal, encCount)` computes shares on ciphertext |
| Ongoing encrypted state management | **No** — each ZK proof is stateless | **Yes** — ciphertext persists across transactions |

**Bottom line:** ZK is a verification tool (prove something about data). FHE is a computation tool (compute on hidden data). RWA portfolio management requires ongoing computation on encrypted state — that's FHE's domain.

### Why not TEE (Trusted Execution Environments)?

TEEs (Intel SGX, ARM TrustZone) provide confidential computation but require trusting the hardware manufacturer. Side-channel attacks against SGX are well-documented. For a financial platform handling regulated securities, "trust Intel" is not an acceptable security assumption.

FHE provides mathematical guarantees — the security comes from lattice-based cryptography, not from trusting a hardware vendor.

### Why not MPC (Multi-Party Computation)?

MPC requires all parties to be online simultaneously and interact. RWA investors are inherently asynchronous — they deposit, then leave. Yield distributions happen on-chain without requiring investor participation. MPC's interactivity requirement makes it unsuitable for this use case.

### Why not a permissioned chain?

Permissioned chains (Canton Network, JP Morgan's Onyx) provide privacy through access control — restricting who can see data. This breaks DeFi composability and creates a walled garden. MuHaven operates on a public chain (Arbitrum) with privacy through encryption, maintaining full composability while hiding values.

---

## 5. Trust Assumptions

| Component | Trust assumption | What happens if compromised |
|-----------|-----------------|----------------------------|
| **Fhenix CoFHE coprocessor** | Threshold network operates honestly (2/3 majority) | Ciphertexts could be decrypted without authorization. Mitigated by threshold requirement. |
| **Arbitrum Sepolia** | L2 sequencer is live and processes transactions | Liveness failure only — no privacy impact. Encrypted state remains encrypted. |
| **ERC3643KYCAdapter** | Admin manages whitelist honestly | Only affects access control, not encryption. Rogue admin can whitelist ineligible addresses but cannot decrypt any balances. |
| **AI agent wallet** | Agent wallet is funded with capped USDC | Agent can only spend what's in the wallet. Session keys (EIP-7702) planned for production. |
| **Client-side encryption** | Investor's browser/device is not compromised | If compromised, attacker sees plaintext before encryption. Standard client security assumption. |

---

## 6. Future Privacy Enhancements

| Enhancement | Impact | Dependency |
|------------|--------|------------|
| Privara encrypted deposits | Eliminates ERC-20 transfer leakage in YieldDistributor | Privara SDK ships with encrypted transfer support |
| Stealth addresses for investors | Hides investor identity from on-chain observer | Wallet-layer integration (e.g., ERC-5564/6538) |
| Encrypted KYC claims (ONCHAINID) | Replaces cleartext whitelist with encrypted credential verification | ERC-3643 ONCHAINID integration |
| Proportional yield with unique ciphertexts | Prevents correlation of equal-split yield shares | FHE proportional math (already possible with `FHE.mul`/`FHE.div`) |
| Randomized transaction batching | Reduces timing correlation for AI agent operations | Agent implementation (Wave 4) |

---

*Privacy is not a feature — it's the architecture. This document will be updated as new privacy mechanisms are implemented.*
