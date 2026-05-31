# MuHaven — Smart Contract Specifications

> Contract surfaces, encrypted types, deployment topology, and the conventions every MuHaven contract follows.

> **Canonical source for current signatures: `contracts/`.** This document is a navigation guide; the Solidity files are authoritative when they disagree.

---

## SDK compatibility

Fhenix CoFHE is under active development. MuHaven contracts are pinned:

| Component | Pinned version | Package |
|---|---|---|
| cofhe-contracts | [`v0.1.3`](https://github.com/FhenixProtocol/cofhe-contracts) | `@fhenixprotocol/cofhe-contracts` |
| @cofhe/sdk (client) | [`v0.5.1`](https://github.com/FhenixProtocol/cofhesdk) | `@cofhe/sdk`, `@cofhe/hardhat-plugin`, `@cofhe/mock-contracts` |
| TFHE runtime (frontend) | `v1.5.3` | `tfhe` |
| cofhe-hardhat-starter | [`sdk-migration`](https://github.com/FhenixProtocol/cofhe-hardhat-starter/tree/sdk-migration) | branch base for the MuHaven repo |

**Setup.** The MuHaven repo is a fork of `cofhe-hardhat-starter` (branch `sdk-migration`) — no separate clone needed. `pnpm install` from the repo root.

**Always check.** [cofhe-docs.fhenix.zone/get-started/introduction/compatibility](https://cofhe-docs.fhenix.zone/get-started/introduction/compatibility) before any SDK update.

> **`euint64` underlying-type breaking change (cofhe-contracts v0.1.0).** The change moved `type euint64` from `uint256` to `bytes32` (same for all encrypted types). This changes ABI selectors for any function with `euint64` parameters — e.g., `confidentialTransferFrom(address,address,uint256)` became `confidentialTransferFrom(address,address,bytes32)`. The 32-byte handle values are identical; only the 4-byte selector differs.
>
> **Impact in MuHaven.** The retired legacy ConfidentialUSDC on Arb Sepolia (`0x6b6e6479…d4ed89f`) predates v0.1.0 and uses `uint256` selectors. MuHaven contracts compile against the post-v0.1.0 `bytes32` ABI. **Resolution.** `MuHavenStable` (mhUSDC) is MuHaven's own confidential USDC wrapper that exposes a clean post-v0.1.0 surface to MuHaven flows and shims the legacy selector internally when forwarding to the legacy token. New code should never touch the legacy token directly.

---

## Encrypted type reference

| Type | Description | Max value | Use in MuHaven |
|---|---|---|---|
| `ebool` | Encrypted boolean | true/false | KYC flags, condition results, signal flags |
| `euint8` | Encrypted 8-bit | 255 | Risk-tier levels |
| `euint16` | Encrypted 16-bit | 65,535 | Basis points (10000 = 100%) |
| `euint32` | Encrypted 32-bit | ~4.2B | Small counters |
| `euint64` | Encrypted 64-bit | ~18.4×10¹⁸ | mhUSDC amounts (6 decimals: max ~18.4T USDC) |
| `euint128` | Encrypted 128-bit | ~3.4×10³⁸ | Token balances, share counts, large amounts |
| `eaddress` | Encrypted address | — | Reserved (ephEOA permits use cleartext addresses) |

**`euint256` does NOT exist in CoFHE.** The maximum encrypted integer is `euint128`.

---

## Contract overview

The production deploy ships **11 platform-singleton contracts** (authoritative addresses in [`deployments/arb-sepolia-v2.json`](../deployments/arb-sepolia-v2.json), deployer `0xe11E83398C33A37CaC02C01c43F14A7f95876986`) plus a **per-token contract triple** deployed by the issuer onboarding wizard for every listed RWA. **11 RWA tokens are live** (CETES, USYC, BUIDL, EUTBL, syrupUSDC, USDY, ONyc, MUon, NVDAon, STRCx, TSLAx — see Deployment §). The earlier contract set (`MuHavenVault`, `YieldDistributor`, `MuHavenEscrow`, `YieldGate`, `ERC3643KYCAdapter`) is retired and superseded by the contracts below — see `deployments/arb-sepolia.json` for the read-only legacy artifact.

`RiskParams` and the encrypted-policy / KYC-attestation / protection / governance primitives (`KYCAttestationRegistry`, `MuHavenKYCVerifier`, `DefaultProtection`, `EncryptedGovernance`) are **deployed to staging/preview only** (not part of the 11 prod platform singletons) — see the per-section notes below.

### Platform singletons

| Contract | Proxy (Arb Sepolia · prod) | Purpose | Key FHE types |
|---|---|---|---|
| `MuHavenStable.sol` | `0xF9bc25b67238C870255c33EC75fA37A09C00edE7` | Confidential USDC wrapper (mhUSDC). Settlement currency for every MuHaven flow. | `euint64` |
| `MuHavenSubscription.sol` | `0x39D49B2614d24ba189B613bEAa903d829A73eA9e` | Atomic single-tx buy/redeem coordinator. Auto-escalates to queue on cap overflow. | `euint128`, `euint64` |
| `TokenRegistry.sol` | `0x4915E9Aa034244e299fb1609792D66b9fFAbf885` | Per-token configuration registry — issuer, oracle binding, treasury / queue / snapshot pointers, paused flag, schedule metadata. | — |
| `InvestorRegistry.sol` | `0xE7D4CB42EdB19e268e5e8a10d1A02f321Bfa50D0` | Per-token holder enumeration. `addHolder` called by `MuHavenToken._transfer` on first transfer-in. | — |
| `MuHavenIdentityRegistry.sol` | `0xD9Ab61fdED044bcBeB9eF687C357A35B5E7E9fAD` | ERC-3643 identity registry. Whitelist + claim verification + `devMode`. | — |
| `ClaimTopicsRegistry.sol` | `0x56Cb047ddCd07aD8217BE54Dd7703D9125D704d4` | ERC-3643 claim-topics catalog. | — |
| `TrustedIssuersRegistry.sol` | `0x4587F75d0bCa84c8C944698b4e23Cb657E8D31B1` | ERC-3643 trusted-issuers list. | — |
| `ModularCompliance.sol` | `0x9A190A310C23FcF9Cd6c5Eab26Eb624B89e4D07a` | Per-token rule-modules registry. AND-aggregates `canTransfer` checks. | — |
| `YieldSnapshot.sol` | `0xaC4163f84db2C85333D5aF6f87848d7362A59887` | Pull-based per-epoch yield distribution. | `euint128`, `euint64`, `ebool` |
| `IssuerControlledOracle.sol` | `0xD30069114dFC83C714B04d6036dEfa64d2E9d583` | Pluggable `IPriceOracle` reference impl — issuer-write NAV with deviation + sequencer-uptime gates. | — |
| `ChainlinkFunctionsOracle.sol` | `0x6a480c6F7553098f7B9b0b285EcB7207a93feC43` | Functions-backed `IPriceOracle` — FRED `DGS3MO`, `GOLDPMGBD228NLBM`, metals-api fallback. | — |

> **`RiskParams.sol`** (encrypted investor risk guardrails, 4× `euint64`) is **not** one of the 11 prod platform singletons — it is deployed to staging/preview as a designed encrypted-policy primitive. See §11.

### Per-token contract triple (deployed by the wizard)

| Contract | Purpose | Key FHE types |
|---|---|---|
| `MuHavenToken.sol` | fhERC-20 RWA token. `SUBSCRIPTION_ROLE` only mint authority. | `euint128` |
| `MuHavenTreasury.sol` | Per-token mhUSDC custody. Immutable operator approvals to Subscription + Queue. | `euint64` |
| `RedemptionQueue.sol` | Overflow redemption queue with epoch settlement. | `euint128`, `euint64` |

### Compliance modules (pluggable via `ModularCompliance`)

| Module | Purpose |
|---|---|
| `CountryAllow`, `CountryRestrict` | Per-token ISO-3166 numeric allow / block lists. Permissive default when no entries. |
| `MaxHolders` | Cap holder count via `InvestorRegistry`; separate accredited / non-accredited counters. |
| `Lockup` | Per-token default lockup window applied on mint + transfer-in (no shortening). Mint always allowed. |
| `MaxBalance` | Cleartext upper-bound tracker fed from `maxSharesHint` (loose by ADR-019). |

---

## Critical CoFHE patterns

Every MuHaven contract follows these. Breaking any of them causes silent failures or information leaks.

### Pattern 1 — Access control after every FHE op

Every new handle from `FHE.add` / `FHE.sub` / `FHE.select` / `FHE.asEuint*` / `FHE.asEaddress` must be authorized before the transaction ends. Otherwise the handle is inaccessible from any subsequent call.

```solidity
// WRONG — result is inaccessible
euint128 result = FHE.add(a, b);

// CORRECT — grant access to contract and value owner
euint128 result = FHE.add(a, b);
FHE.allowThis(result);                         // contract reuses the handle later
FHE.allow(result, ownerEphemeralEOA);          // ownerEph can decryptForView via permit
```

`FHE.allowSender(h)` is the shortcut when the value owner is `msg.sender`. `FHE.allowPublic(h)` only for truly public aggregates (e.g. optional public total supply) — irreversible.

**ADR-021 — ephemeral-EOA permit signer.** Every mutation that produces investor-decryptable state grants `FHE.allow(handle, ephemeralEOA)` to the user's per-session signer (random EOA generated in-memory at first-write-op). The user signs decrypt permits with the same eph. Replaces kernel-signed permits which broke under ERC-1271 verification timing post-deploy.

**ADR-044 — split-grant `transferFrom`.** Wrappers/snapshots that move encrypted amounts on behalf of investors expose a 5-arg overload `(from, to, encAmount, fromEph, toEph)`. Pass `address(0)` for the leg that should NOT receive the counterparty `FHE.allow` grant (e.g. `Subscription.purchase` passes `(investor_eph, address(0))` so only the investor gets a decrypt permit on the post-pull mhUSDC handle, not the treasury).

### Pattern 2 — Permit-based client decrypt

`sealOutput` / `sealoutputTyped` was removed in cofhe-contracts v0.1.3. Client UI reads use permit-based `decryptForView` instead:

```solidity
// Contract: grant the value owner permit access to the current ciphertext handle
function mintFromSubscription(address to, euint128 encShares, address eph) external {
    _balances[to] = FHE.add(_balances[to], encShares);
    FHE.allowThis(_balances[to]);
    FHE.allow(_balances[to], eph);          // critical — permit for new handle
}
```

```typescript
// Client: decrypt via permit — no on-chain task, no polling
const balance = await cofheClient
  .decryptForView(handle)
  .forType(FheTypes.Uint128)
  .withPermit()
  .execute();
```

Because every `FHE.add` / `FHE.sub` / `FHE.select` produces a new handle, `FHE.allow` must be re-granted on the new handle after every mutation. `MuHavenToken.snapshotBalance` (read by `YieldSnapshot.snapshotBatch`) re-grants the issuer's ACL on the snapshot handle to support ADR-049's "Decrypt from chain" issuer UX.

### Pattern 3 — Silent failure with `FHE.select`

```solidity
// WRONG — reveals whether the operation succeeded
require(FHE.decrypt(FHE.gte(balance, amount)), "Insufficient");   // LEAKS

// CORRECT — branchless conditional zero, identical gas on success and failure
euint128 transferAmount = FHE.select(
    FHE.gte(balance, amount),     // condition
    amount,                       // if true:  use amount
    FHE.asEuint128(0)             // if false: use zero
);
FHE.allowThis(transferAmount);
```

Side-channel property: a valid and a silently-nullified operation take identical gas, so gas observers cannot distinguish success from failure. Applied consistently across `MuHavenToken`, `MuHavenStable`, `MuHavenSubscription`, `MuHavenTreasury`, `RedemptionQueue`, `YieldSnapshot`.

### Pattern 4 — Silent-fail-bounded conservation primitives

Operations that move encrypted amounts on behalf of an investor (escrow / snapshot / distributor payouts) **must return the silent-fail-bounded actual handle**, never the requested amount, so downstream contracts can't be spoofed into spending more than was conserved on the input leg. Locked in ADR-030 + ADR-036:

```solidity
// MuHavenToken.burnFromSubscription returns the actual silent-fail-bounded amount,
// not the requested amount. Subscription mirrors that handle into FHE.mul so the
// payout cannot exceed shares the investor actually held.
function burnFromSubscription(address from, euint128 requested, address eph)
    external
    returns (euint128 actualBurned)
{
    ebool ok = FHE.gte(_balances[from], requested);
    actualBurned = FHE.select(ok, requested, FHE.asEuint128(0));
    _balances[from] = FHE.sub(_balances[from], actualBurned);
    FHE.allowThis(actualBurned);
    FHE.allowThis(_balances[from]);
    FHE.allow(_balances[from], eph);
    return actualBurned;
}
```

Sweep checklist for new encrypted-math surfaces (the staging/preview policy primitives — see §11): `DefaultProtection.triggerPayout`, `EncryptedGovernance.tally`, `KYCAttestationRegistry.prepareAttestation`. Reuse the `CostOverflowsPUSDCWidth` cleartext guard shape on any path that narrows `euint128` into the mhUSDC `euint64` width.

### Pattern 5 — Guarded uninitialized handles

FHE operations on the zero handle (e.g. a `mapping`-default `euint128`) revert. Contracts that may read storage before first write must guard:

```solidity
import "@fhenixprotocol/cofhe-contracts/Common.sol";

if (Common.isInitialized(_balances[to])) {
    _balances[to] = FHE.add(_balances[to], amount);
} else {
    _balances[to] = amount;
}
FHE.allowThis(_balances[to]);
FHE.allow(_balances[to], eph);
```

### Pattern 6 — On-chain async decrypt (only when plaintext must reach the EVM)

When contract logic genuinely needs a plaintext (not a UI read), use the async decrypt flow:

```solidity
ITaskManager(taskManager).createDecryptTask(handle);
// ... coprocessor delay (~seconds on testnet) ...
(uint256 value, bool ready) = FHE.getDecryptResultSafe(handle);
require(ready, "Decrypt not ready");
```

Prefer `decryptForTx` + `publishDecryptResult` over polling. `RiskParams.settleBreachDecrypt` is the canonical breach-decrypt path. **Never return raw `euint` handles from external functions to untrusted callers.**

### Pattern 7 — Trusted-payer fast-path

`MuHavenStable.trustedPayout(to, encAmount, eph)` bypasses `_silentFailBound` for known-conservation callers (escrow / snapshot / distributor). Restricted via `_trustedPayer` mapping (owner-only setter). Per-epoch conservation in `YieldSnapshot` guarantees the snapshot's float covers every legitimate claim, so skipping `_silentFailBound` on this leg is structurally safe and cuts the wrapper-side FHE chain from 5 → 2 ops (closing the cofhe TN chain-length blocker on the claim path). ADR-046.

**Operational note.** `scripts/deploy-v2.ts` folds `stable.setTrustedPayer(yieldSnapshot, true)` into the platform deploy — fresh deploys are claim-ready by construction. Recovery for botched deploys: `scripts/grant-trusted-payer.ts` (idempotent — reads `isTrustedPayer` first).

---

## 1. MuHavenStable.sol (mhUSDC)

MuHaven's own confidential USDC wrapper. Layered over the legacy confidential-USDC ABI to bridge the pre-v0.1.0 / post-v0.1.0 selector mismatch (see top of this doc). Adds `_silentFailBound` semantics, the 5-arg `transferFrom` overload (ADR-044), `trustedPayout` (ADR-046), and a **direct USDC entry/exit** path against an owner-seeded USDC reserve (`wrapUsdc` deposit; async `withdrawToUsdc` → `claimUsdc` exit — shipped live on prod).

### Surface

```solidity
// Wrap / unwrap
function wrap(uint256 amount) external;
function unwrap(uint256 amount, address eph) external;
function getBalanceHandle(address account) external view returns (euint64);

// Direct USDC entry — single-step Circle-USDC → reserve deposit, mhUSDC out (shipped live)
function wrapUsdc(uint256 amount, address eph) external;

// Direct USDC exit — async burn → decrypt → claim from the owner-seeded USDC reserve (shipped live)
function withdrawToUsdc(uint256 amount, address eph) external;   // requests the async burn/decrypt
function claimUsdc() external;                                   // claims cleartext USDC once decrypt is ready

// 4-arg transferFrom — both legs receive FHE.allow grants (P2P / direct)
function transferFrom(address from, address to, euint64 encAmount, address eph)
    external returns (bool);

// 5-arg transferFrom (ADR-044) — pass address(0) for the leg that should NOT
// receive the counterparty FHE.allow grant. Used by Subscription / Queue / Snapshot.
function transferFrom(address from, address to, euint64 encAmount, address fromEph, address toEph)
    external returns (bool);

// Trusted-payout fast-path (ADR-046) — bypasses _silentFailBound. Caller MUST be
// in _trustedPayer mapping (snapshot / queue / future distributor).
function trustedPayout(address to, euint64 encAmount, address toEph)
    external returns (bool);

// Owner-only
function setTrustedPayer(address payer, bool authorized) external;
function isTrustedPayer(address payer) external view returns (bool);

// Legacy confidential-USDC-shape selectors preserved for any path still touching the legacy token directly
function confidentialTransfer(address to, uint256 encAmountHandle) external;
function confidentialTransferFrom(address from, address to, uint256 encAmountHandle) external;
```

### Storage

```solidity
mapping(address => euint64) private _balances;
mapping(address => bool) private _trustedPayer;
address public owner;
address public legacyPusdc;          // shim target (internal field — historical name retained)
uint256[41] private __gap;           // upgrade gap (was 42 before _trustedPayer slot, ADR-046)
```

### Conservation invariant

For any direct `transferFrom` call (4-arg or 5-arg, non-trusted), the `_silentFailBound` runs `FHE.gte(balance[from], encAmount)` and silent-fails on insufficiency. `trustedPayout` skips that check — see Pattern 7 for why this is safe.

---

## 2. MuHavenSubscription.sol

Atomic single-tx buy/redeem coordinator — the platform's purchase/redeem primitive, replacing an earlier investor-as-minter shortcut with a single atomic, compliance-gated flow.

### Surface

```solidity
// Atomic purchase: KYC → compliance → oracle → FHE.mul → mhUSDC pull → mint
function purchase(
    address token,
    InEuint128 calldata encAmount,        // mhUSDC amount, encrypted client-side
    uint128 maxSharesHint,                // cleartext upper bound for silent-fail gate
    address ephemeralEOA                  // session signer for FHE.allow grants
) external;

// Instant redeem with auto-escalate to RedemptionQueue on cap overflow
function redeem(
    address token,
    InEuint128 calldata encShares,
    uint128 maxSharesHint,
    address ephemeralEOA
) external returns (bool escalated, uint256 requestId);

// Cleartext per-epoch redemption cap state (Subscription owns the counter)
function getCapInfo(address token) external view returns (
    uint128 currentEpochCap,
    uint128 currentEpochUsed,
    uint64  epochStartTs
);

// Configuration (owner-only)
function setIdentityRegistry(address registry) external;
function setModularCompliance(address compliance) external;
function setRedemptionCap(address token, uint128 capPerEpoch) external;
```

### Purchase flow

```solidity
function purchase(address token, InEuint128 calldata encAmount, uint128 maxSharesHint, address eph) external {
    // IdentityRegistry first, kycGate fallback
    require(identityRegistry.isVerified(msg.sender), "KYC: not verified");
    _requireCompliance(token, address(0), msg.sender);  // mint convention

    // Oracle freshness + deviation + sequencer
    (uint128 nav, ) = IPriceOracle(_oracleFor(token)).getNAV(token);
    require(IPriceOracle(_oracleFor(token)).isFresh(token), "Stale NAV");

    euint128 amount = FHE.asEuint128(encAmount);
    FHE.allowThis(amount);

    // Cleartext guard on mhUSDC width before narrow (ADR-031)
    if (uint256(maxSharesHint) * uint256(nav) > type(uint64).max) revert CostOverflowsPUSDCWidth();

    euint128 encShares = FHE.mul(amount, FHE.asEuint128(uint256(nav)));
    encShares = FHE.select(FHE.lte(encShares, FHE.asEuint128(maxSharesHint)), encShares, FHE.asEuint128(0));
    FHE.allowThis(encShares);

    // mhUSDC pull — 5-arg overload, only investor leg gets FHE.allow on post-pull handle
    euint64 encCost64 = FHE.asEuint64(amount);
    IMuHavenStable(pusdc).transferFrom(msg.sender, _treasuryFor(token), encCost64, eph, address(0));

    // Mint shares — Subscription holds SUBSCRIPTION_ROLE on each token
    IMuHavenToken(token).mintFromSubscription(msg.sender, encShares, eph);

    // Compliance state hook
    _notifyCreated(token, msg.sender);
    emit Purchased(token, msg.sender, maxSharesHint, eph, ...);
}
```

### Redemption flow

`redeem()` mirrors `purchase()` — burn shares via `MuHavenToken.burnFromSubscription` (returns silent-fail-bounded `actualBurned`, ADR-030), pay out mhUSDC via `MuHavenStable.transferFrom`. Cap tracking via cleartext `maxSharesHint * nav` per ADR-004; counter increments only on the instant-success branch. Cap-exceeded silently emits `Redeemed(escalated=true)` and forwards to `RedemptionQueue.submitFor` (ADR-035).

### Tests

29 unit cases covering KYC + compliance gates, oracle freshness, FHE-mul precision, silent-fail boundaries, cap tracker, escalate path. 5 integration cases with real `IssuerControlledOracle` (deviation gate exercised end-to-end). See `test/MuHavenSubscriptionPurchase.test.ts`, `test/MuHavenSubscriptionRedeem.test.ts`, `test/MuHavenSubscription.integration.test.ts`.

---

## 3. MuHavenToken.sol (per-token, fhERC-20)

fhERC-20 RWA token. Deployed once per RWA by the issuer onboarding wizard (`scripts/onboard-token.ts`). Issuer no longer holds `MINTER_ROLE` — only `MuHavenSubscription` (via `SUBSCRIPTION_ROLE`) and `RedemptionQueue` (via `BURN_ROLE` for queue-held shares) can mutate supply.

An **over-sell clamp via `FHE.min`** is shipped live on the current token implementation: an over-balance redeem now sells the investor's **full** position instead of silent-failing to zero (applies on both the instant `_burnInternal` path and the queue path).

### Surface

```solidity
// Replaced — only Subscription / Queue mint or burn now
function mintFromSubscription(address to, euint128 encShares, address eph)
    external onlySubscription;

function burnFromSubscription(address from, euint128 requested, address eph)
    external onlySubscription
    returns (euint128 actualBurned);          // silent-fail-bounded per ADR-030

function burnFromQueue(address from, euint128 requested)
    external onlyQueue
    returns (euint128 actualBurned);

function returnToInvestor(address to, euint128 encShares)
    external onlyQueue;                       // KYC-revocation refund path (ADR-027)

// Transfer + transferFrom call InvestorRegistry.addHolder(token, recipient)
// on first-transfer-in per ADR-022. Handled in _transfer / _mintInternal.
function transfer(address to, InEuint128 calldata encAmount, address eph) external returns (bool);
function transferFrom(address from, address to, InEuint128 calldata encAmount, address eph) external returns (bool);

// Snapshot read for YieldSnapshot.snapshotBatch — re-grants ACL on the snapshot
// handle to the issuer per ADR-049 ("Decrypt from chain" issuer UX)
function snapshotBalance(address holder) external returns (euint128);

// Read surface
function encryptedBalanceOf(address account) external view returns (euint128);
function encryptedTotalSupply() external view returns (euint128);

// Optional public total supply (irreversible — uses FHE.allowPublic)
function setTotalSupplyPublic() external onlyOwner;

// `authorizedReaders` mapping for governance balance access (consumed by the
// staging/preview EncryptedGovernance primitive — see §11)
mapping(address => bool) public authorizedReaders;
function setAuthorizedReader(address reader, bool authorized) external onlyOwner;
function getBalanceForGovernance(address holder) external view returns (euint128);
function getTotalSupplyForGovernance() external view returns (euint128);
```

### What's gone

- `mint()` open to any minter — replaced by `mintFromSubscription` (only Subscription) + `burnFromQueue` (only Queue). Issuer can no longer conjure shares. Blast-radius reduction.
- `depositYield()` — yield distribution is now pull-based via `YieldSnapshot.fundEpoch`.
- `getInvestors()` — moved to per-token `InvestorRegistry`; `MuHavenToken._transfer` calls `InvestorRegistry.addHolder` on first transfer-in.
- `balanceOfSealed` / `PermissionedV2` / `SealedUint` — removed in cofhe-contracts v0.1.3. Use permit-based `decryptForView` (Pattern 2).

### Tests

22 unit cases — `mintFromSubscription` happy path, KYC gate, ACL grants, `burnFromSubscription` silent-fail-bounded return, ephemeralEOA permit lifecycle. See `test/MuHavenTokenV2Delta.test.ts`.

---

## 4. MuHavenTreasury.sol (per-token)

Per-token mhUSDC custody. Immutable operator approvals to `MuHavenSubscription` + `RedemptionQueue` granted at `initialize()` and never revoked (ADR-002).

### Surface

```solidity
function initialize(
    address _token,
    address _subscription,
    address _queue,
    address _pusdc,                 // MuHavenStable for new tokens; legacy for migration
    uint64  _minFloat
) external initializer;

// Operator approvals are immutable — granted in initialize()
// Subscription pulls mhUSDC on purchase; Queue pulls on processEpoch settlement.

function getMinFloat(address token) external view returns (uint64);
function setMinFloat(uint64 newMin) external onlyIssuer;

// Withdraw with solvency-floor silent-fail (FHE.select, ADR-029)
function withdraw(address recipient, euint64 encAmount, address eph)
    external onlyIssuer;

// getFloat returns 0 — async-decrypt cache deferred (ADR-029)
function getFloat() external view returns (uint64);
```

### Solvency-floor pattern

Empty-treasury short-circuit on the mhUSDC transfer (avoids `NoBalance` revert from the underlying `_doTransfer`). Withdraw passes through `FHE.select(balance - encAmount >= minFloat, encAmount, 0)`. Same gas cost on success and failure paths.

### Tests

24 unit cases including init / immutable approvals / `minFloat` boundary / empty-treasury / withdraw silent-fail. See `test/MuHavenTreasury.test.ts`.

---

## 5. RedemptionQueue.sol (per-token)

Overflow redemption queue. `MuHavenSubscription.redeem` auto-escalates here when the per-epoch cleartext cap is exceeded. Settlement is issuer-driven, paginated.

### Surface

```solidity
struct QueueRequest {
    address investor;
    euint128 encShares;             // burned at submission
    uint128  maxSharesHint;         // cleartext for cap tracker
    address  ephemeralEOA;          // captured at submission per ADR-035
    uint64   submittedAtEpoch;
    bool     settled;
    bool     claimed;
    bool     cancelled;
}

// Direct submission (rare — usually called via Subscription.redeem cap-overflow)
function submit(InEuint128 calldata encShares, uint128 maxSharesHint, address eph)
    external returns (uint256 requestId);

// Trusted-caller variant for Subscription auto-escalate (ADR-035)
function submitFor(address investor, euint128 encShares, uint128 hint, address eph)
    external onlySubscription returns (uint256 requestId);

// Issuer-driven settlement at NAV; idempotent per (epoch, request)
function processEpoch(uint64 epochId, uint128 navAtSettlement)
    external onlyIssuer;

// Atomic settlement — flips settled=claimed=true atomically
// (investor claim() always reverts AlreadyClaimed)
function claim(uint256 requestId) external view returns (bool);

// Issuer-only KYC-revocation refund per ADR-027
function cancelOnKYCRevocation(uint256 requestId) external onlyIssuer;

function getRequest(uint256 requestId) external view returns (QueueRequest memory);
```

### Conservation guard

`processEpoch` re-runs the `CostOverflowsPUSDCWidth` guard per-request (ADR-031 lock-in) and burns queue-held shares via `MuHavenToken.burnFromQueue` to keep `encryptedTotalSupply` consistent. Pulls mhUSDC from treasury via the 5-arg `transferFrom` overload (`from = treasury, to = queue, fromEph = address(0), toEph = investor_eph`). `actualPulled` via the new Token primitives per ADR-036 prevents the free-money exploit at claim time.

### Tests

41 unit cases (submit / submitFor / processEpoch / claim / admin + 2 review-pass lockdowns) + 5 integration cases. See `test/RedemptionQueue.test.ts`, `test/RedemptionQueue.integration.test.ts`.

---

## 6. YieldSnapshot.sol

Pull-based per-epoch yield distribution. Replaces the earlier push-model `YieldDistributor` + per-investor `MuHavenEscrow`.

### Surface

```solidity
struct Epoch {
    address  token;
    uint64   snapshotStartTs;
    uint64   funded;                // 0 / 1 / 2 — phase enum
    uint128  totalYield;
    uint128  ratePerShare;          // cleartext, scaled by RATE_SCALE (ADR-048)
    euint128 encTotalSupply;        // running sum during snapshotBatch (ADR-038)
    uint64   holderCount;
    uint64   claimWindowEnd;
    bool     swept;
}

uint128 public constant RATE_SCALE = 1_000_000;

function openEpoch(address token) external onlyIssuer returns (uint64 epochId);

// Idempotent per (epoch, investor); skips zero-address entries
function snapshotBatch(uint64 epochId, address[] calldata investors) external onlyIssuer;

// Locks the phase; reverts EmptySnapshot when holderCount == 0
function finalizeSnapshot(uint64 epochId) external onlyIssuer;

// Pulls totalYield mhUSDC; stores cleartext ratePerShare
function fundEpoch(uint64 epochId, uint128 totalYield, uint128 ratePerShare)
    external onlyIssuer;

// Investor-pull. Idempotent (AlreadyClaimed on re-claim). Pay-out via trustedPayout.
function claimYield(address token, uint64 epochId, address eph) external;

// Returns unclaimed yield to issuer after claimWindowEnd
function sweepExpired(uint64 epochId) external onlyIssuer;

// Issuer "Decrypt from chain" UX (ADR-049) — encTotalSupply ACL granted at finalize
function getEpochTotalSupplyHandle(uint64 epochId) external view returns (euint128);

// Re-grants encTotalSupply ACL to a fresh ephemeralEOA (ADR-050 — cross-session safety)
function refreshSnapshotSupplyGrant(uint64 epochId, address eph) external;
```

### claimYield internals

```solidity
function claimYield(address token, uint64 epochId, address eph) external {
    Epoch storage e = _epochs[epochId];
    require(e.funded == 2, "Not funded");
    require(e.token == token, "Wrong token");
    require(!_claimed[epochId][msg.sender], "AlreadyClaimed");
    _claimed[epochId][msg.sender] = true;

    euint128 snapshotBal = _snapshotBalance[epochId][msg.sender];
    require(Common.isInitialized(snapshotBal), "No snapshot");

    // Cleartext rate path — sidesteps cofhe TN chain-length cap
    euint128 encShare128 = FHE.mul(snapshotBal, FHE.asEuint128(uint256(e.ratePerShare)));
    FHE.allowThis(encShare128);

    // Sub-1:1 yield rescale (ADR-048)
    euint128 rescaled128 = FHE.div(encShare128, FHE.asEuint128(uint256(RATE_SCALE)));
    FHE.allowThis(rescaled128);

    // Narrow to euint64 width with cleartext guard
    if (e.totalYield > type(uint64).max) revert CostOverflowsPUSDCWidth();
    euint64 encShare64 = FHE.asEuint64(rescaled128);
    FHE.allowThis(encShare64);
    FHE.allow(encShare64, eph);

    // Trusted-payout fast-path (ADR-046) — bypass _silentFailBound
    IMuHavenStable(pusdc).trustedPayout(msg.sender, encShare64, eph);

    emit EpochClaimed(epochId, msg.sender);
}
```

### Backward-compat

Pre-cleartext-rate epochs (`ratePerShare == 0` in storage) fall through to the legacy `encRatio` path in claimYield for any in-flight epoch from before the cleartext-rate cutover — covered by `scripts/upgrade-yield-snapshot.ts` pre-flight enumeration.

### Tests

See `test/YieldSnapshot.test.ts`.

---

## 7. TokenRegistry.sol

Per-token configuration registry.

```solidity
struct TokenConfig {
    address issuer;
    address oracle;                 // IssuerControlledOracle or ChainlinkFunctionsOracle
    address treasury;
    address queue;
    address snapshot;
    bool    paused;
    uint64  yieldScheduleSeconds;   // metadata only — actual cadence is operator-driven
}

function register(address token, TokenConfig calldata config) external onlyAuthorized;
function getConfig(address token) external view returns (TokenConfig memory);
function setOracle(address token, address oracle) external onlyIssuer;
function setPaused(address token, bool paused) external onlyIssuer;
function getRegisteredTokens(uint256 offset, uint256 limit) external view returns (address[] memory);
```

25 unit cases. See `test/TokenRegistry.test.ts`.

---

## 8. InvestorRegistry.sol

Per-token holder enumeration. `addHolder` called by `MuHavenToken._transfer` on first-transfer-in. Used by `YieldSnapshot.snapshotBatch` and `MaxHolders` compliance module.

```solidity
function addHolder(address token, address holder) external onlyAuthorizedToken;
function isHolder(address token, address holder) external view returns (bool);
function count(address token) external view returns (uint256);
function getInvestors(address token, uint256 offset, uint256 limit)
    external view returns (address[] memory);
```

Add-only semantics per ADR-026 — even when an investor's balance returns to zero, they remain in the registry. The `MaxHolders` module reconciles by comparing `InvestorRegistry.count` against its cap (upper-bound semantics, ADR-022).

---

## 9. ERC-3643 topology

### MuHavenIdentityRegistry.sol

`isVerified(addr)` runs whitelist → claim verification (topics × trusted issuers × `validUntil`); `devMode` flag for migration; `disableDevModeForever()` is an irreversible latch (ADR-023).

```solidity
function isVerified(address account) external view returns (bool);
function addToWhitelist(address account) external onlyOperator;
function removeFromWhitelist(address account) external onlyOperator;

// Per-account compliance metadata (ADR-033)
function setCountryOf(address account, uint16 isoCountryCode) external;
function getCountryOf(address account) external view returns (uint16);
function setAccredited(address account, bool accredited) external;
function isAccredited(address account) external view returns (bool);

// Dev-mode (ADR-011, ADR-023)
bool public devMode;
function disableDevModeForever() external onlyOwner;
event DevModeToggled(bool newValue);
```

30 unit cases + 14 across `ClaimTopicsRegistry` + `TrustedIssuersRegistry`. See `test/MuHavenIdentityRegistry.test.ts`, `test/ClaimAndIssuerRegistries.test.ts`.

### ModularCompliance.sol

Per-token rule-modules registry. AND-aggregates active modules with short-circuit; state hooks fire on mint / transfer / burn (ADR-032 — per-token authorized-caller gate).

```solidity
function bindModule(address token, address module) external onlyOperator;
function unbindModule(address token, address module) external onlyOperator;
function getModules(address token) external view returns (address[] memory);

function canTransfer(address token, address from, address to)
    external returns (bool);

// State hooks — fan-out to bound modules
function created(address token, address to) external onlyAuthorized;
function transferred(address token, address from, address to) external onlyAuthorized;
function destroyed(address token, address from) external onlyAuthorized;

uint256 public constant MAX_MODULES_PER_TOKEN = 8;   // swap-and-pop cap
```

20 unit cases. See `test/ModularCompliance.test.ts`.

### Modules

| Module | Purpose | Tests |
|---|---|---|
| `CountryAllow.sol` | ISO-3166 numeric allow-list per token. Permissive default when no entries. | 6 |
| `CountryRestrict.sol` | ISO-3166 numeric block-list. Zero-address (mint `from` / burn `to`) skipped. | 6 |
| `MaxHolders.sol` | Cap holder count via `InvestorRegistry.count`. Separate accredited / non-accredited counters. | 6 |
| `Lockup.sol` | Per-token default lockup window. Mint always allowed; transfer-out blocked during lockup. Owner override for migration. | 5 |
| `MaxBalance.sol` | Cleartext upper-bound tracker fed from `maxSharesHint`. Loose by ADR-019 + ADR-034. | 8 |

All test cases in `test/ComplianceModules.test.ts` + `test/ComplianceIntegration.test.ts`.

---

## 10. Oracles

### IssuerControlledOracle.sol

Pluggable `IPriceOracle` reference impl — issuer-write NAV with rotation, configurable staleness, deviation gate, sequencer-uptime check.

```solidity
function getNAV(address token) external view returns (uint128 value, uint64 updatedAt);
function isFresh(address token) external view returns (bool);

// Per-token navWriter rotation (hot key separate from owner multisig)
function setNavWriter(address token, address writer) external onlyOwner;
function getNavWriter(address token) external view returns (address);

// Issuer-only NAV write, gated by deviation
function setNAV(address token, uint128 value) external;

// Per-token deviation gate — over-threshold writes park in pending state
function setMaxDeviationBps(address token, uint16 bps) external onlyOwner;  // hard-cap 5000 bps
function acceptPendingNAV(address token) external onlyOwner;
function rejectPendingNAV(address token) external onlyOwner;

// Per-token staleness window (default 36h)
function setStalenessSeconds(address token, uint64 seconds_) external onlyOwner;

// L2 sequencer uptime feed (Chainlink-shaped AggregatorV3Interface)
function setSequencerUptimeFeed(address feed) external onlyOwner;
function setSequencerGracePeriod(uint64 seconds_) external onlyOwner;  // hard-cap 24h
```

Fails closed on a misconfigured (EOA) feed via low-level staticcall. 33 base + 10 deviation-gate + 6 sequencer-uptime cases. See `test/IssuerControlledOracle.test.ts`.

### ChainlinkFunctionsOracle.sol

Functions consumer pulling FRED + metals-api fallbacks. Per-token CBOR request body + per-token `navRequester` hot key.

```solidity
function setTokenConfig(address token, bytes calldata cborRequest, uint32 gasLimit, ...)
    external onlyOwner;
function setNavRequester(address token, address requester) external onlyOwner;

// Triggers the off-chain Functions request; callback writes through to setNAV
function requestNAV(address token) external;

// Functions router callback
function fulfillRequest(bytes32 requestId, bytes memory response, bytes memory err)
    external onlyRouter;
```

32 unit cases. See `test/ChainlinkFunctionsOracle.test.ts`. Mock Functions router + client in `contracts/mocks/`.

---

## 11. RiskParams.sol (staging/preview)

> **Not deployed to prod.** `RiskParams` and the related encrypted-policy / KYC-attestation / protection / governance primitives below are deployed to **staging/preview only** (the `p11` block of `deployments/arb-sepolia-v2.staging.json`), not to the 11 prod platform singletons. This section documents the designed surface.

Encrypted investor risk guardrails (4× `euint64`) plus per-investor pause / spend-epoch / agent-permit-nonce mappings + cleartext oracle-staleness packed slot + KYC gate pointer.

```solidity
struct InvestorRisk {
    euint64 maxDrawdownBps;
    euint64 minYieldBps;
    euint64 driftToleranceBps;
    euint64 maxDailySpend;
    uint256 lastUpdated;
}

function setRiskParams(
    InEuint64 calldata maxDrawdown,
    InEuint64 calldata minYield,
    InEuint64 calldata driftTolerance,
    InEuint64 calldata maxDailySpend
) external;

function hasRiskParams(address user) external view returns (bool);
function getEncryptedParams(address user) external view returns (
    euint64 maxDrawdown, euint64 minYield, euint64 drift, euint64 maxDailySpend
);
```

### Encrypted-policy primitives (per ADR-1; staging/preview)

Branchless `FHE.select` hot-path with **cleartext gates short-circuiting BEFORE the encrypted leg** (oracle-stale / KYC-revoked / user-paused / unknown-action), plus encrypted `FHE.lte` against the per-investor `maxDailySpend` cap. Returns `(ebool ePassed, uint8 breachId)` so callers receive both the encrypted result handle (for downstream encrypted-leg enforcement) AND the cleartext breach taxonomy code (for short-circuit on oracle/KYC/pause failures, no decrypt round-trip needed):

```solidity
function checkAndExecute(
    address investor,
    InEuint64 calldata eAmount,
    uint8 actionId
) external returns (ebool ePassed, uint8 breachId);

event PolicyChecked(
    address indexed investor,
    uint8 indexed actionId,
    ebool encryptedBreachFlag,
    uint8 breachId
);

// BreachCode (cleartext, returned as `breachId` from checkAndExecute):
//   BREACH_NONE = 0, ORACLE_STALE = 1, KYC_REVOKED = 2,
//   USER_PAUSED = 3, UNKNOWN_ACTION = 4
```

Async-decrypt path on the encrypted leg ONLY when the cleartext `breachId == 0` (i.e., cleartext gates passed but encrypted check may still indicate a breach). Operator submits the TN-signed decrypt result via `FHE.publishDecryptResult` — **reverts on wrong-cleartext signature** so operators can ONLY land an actual breach commit (a forged signature for cleartext=true / "no breach" fails at the TN signer recovery):

```solidity
function settleBreachDecrypt(
    address investor,
    uint8 triggerCode,
    uint64 thresholdSnapshot,
    ebool encryptedBreachFlag,
    bytes calldata signature
) external onlyOwner;

event RiskBreach(address indexed investor, uint8 triggerCode, uint64 thresholdSnapshot);
event BreachSettled(address indexed investor, uint32 pausedUntil);
// Sets _pausedUntil[investor] = type(uint32).max on successful settle.
```

Encrypted signal flags computed against client-supplied current-state encrypted values; emits `SignalsComputed` so callers recover the ebool handles from the receipt (the staticCall path can't see the mock TaskManager's `mockStorage` write because it's reverted on staticCall):

```solidity
function computeSignalFlags(
    address investor,
    InEuint64 calldata eCurrentDriftBps,
    InEuint64 calldata eCurrentYieldBps
) external returns (ebool isOverexposed, ebool isUnderYield);

event SignalsComputed(address indexed investor, ebool isOverexposed, ebool isUnderYield);
```

Investor-signed `AgentPermit` EIP-712 schema for action authorization — domain `"MuHaven AgentPermit" v1`. `consumeAgentPermit` is owner-only, enforces strictly-monotonic nonces, and uses OZ `ECDSA.recover` (which enforces s-malleability):

```solidity
struct AgentPermit {
    address investor;
    uint8 tier;        // 0 Advisory / 1 ConfirmPerAction / 2 PolicyBound
    uint8 surface;     // 0 HavenBot / 1 MCP / 2 OpenClaw / 3 Checkout
    uint8 actionId;
    uint256 maxAmount;
    uint64 nonce;
    uint256 expiry;
}

function hashAgentPermit(...) public view returns (bytes32);
function isAgentPermitValid(AgentPermit calldata permit, bytes calldata signature)
    external view returns (bool);
function consumeAgentPermit(AgentPermit calldata permit, bytes calldata signature)
    external onlyOwner;

event AgentPermitConsumed(
    address indexed investor,
    uint8 indexed tier,
    uint8 surface,
    uint8 actionId,
    uint64 nonce,
    uint256 maxAmount
);
```

**Storage layout:** 5 new slots appended at contract scope (`kycGate` address; packed `lastOracleUpdate uint64 + oracleStalenessSec uint64`; `_pausedUntil mapping`; `_lastSpendEpoch mapping`; `_agentPermitNonces mapping`); `__gap` reduced 50 → 45; total slots preserved at 53. Append-only, OZ-storage-safe — verified slot-by-slot.

**Backend wiring:** `OnChainRiskParamsAdapter` (in `backend/src/infrastructure/agent/`) replaces a stub `StubRiskParamsAdapter` behind env toggle `RISK_PARAMS_ADAPTER=onchain` (requires `RPC_URL` + `RISK_PARAMS_ADDRESS` + `AGENT_POLICY_PRIVATE_KEY`). The cron tick encrypts candidate-spend = 0 — a deliberate simplification; the encrypted leg is enforced at UserOp commit time (the cron only enforces cleartext gates). FHE worker route `POST /api/v1/decrypt/for-tx` wraps `cofheClient.decryptForTx(handle).withPermit().execute()`.

**Latency bench:** `decryptForTx` p50 = 1.22s / p99 = 1.25s; end-to-end breach commit ~2.5–3s on Arb Sepolia.

---

## EIP standards compliance

### Implemented

| EIP | Where | Notes |
|---|---|---|
| **EIP-165** | All proxy-backed contracts via `ERC165Upgradeable` | SDK uses for sanity-checks at construction |
| **EIP-1967 / EIP-1822** (transparent proxies) | All upgradeable contracts | OZ Transparent Upgradeable Proxy. Proxy + impl addresses recorded in `deployments/arb-sepolia-v2.json` |
| **EIP-712** (typed signed data) | Permit-based FHE decryption (`FHE.allow` + `decryptForView`); auth flow nonce/verify; ephemeralEOA permit signing per ADR-021 | Frontend signs EIP-712 via ZeroDev passkey kernel |
| **EIP-4337** (account abstraction) | Frontend — ZeroDev kernel smart accounts | All user writes are UserOps; `@zerodev/permissions` validators install `CallPolicy` / `GasPolicy` / `RateLimitPolicy` session keys |
| **ERC-3643** (T-REX, regulated securities) | `MuHavenIdentityRegistry` + `ModularCompliance` + `CountryAllow` / `CountryRestrict` / `MaxHolders` / `Lockup` / `MaxBalance` | Full topology shipped. Production cutover invokes `disableDevModeForever()` to close the migration KYC bypass. |

### Partial / scoped

| EIP | Status | What's there | What's planned |
|---|---|---|---|
| **ERC-3643 — claim verification path** | Partial | Whitelist + claim-topics scaffolding (`ClaimTopicsRegistry` + `TrustedIssuersRegistry`); `validUntil` claim expiry; `MuHavenIdentityRegistry.isVerified` runs whitelist → claim path | Full ONCHAINID integration on production cutover. Hackathon runs `devMode=true` (permissive). |

### Planned (not yet shipped)

| EIP | Target | Rationale |
|---|---|---|
| **ERC-4626** (tokenized vault) | `MuHavenTreasury` re-skin | Composability with DeFi aggregators. Not prioritized — current treasury is per-token mhUSDC custody, not a yield-bearing vault |
| **ERC-7540** (async deposit/redeem) | `MuHavenSubscription`, `RedemptionQueue` | Matches FHE's inherent async nature (coprocessor delay, queue settlement). Natural upgrade once CoFHE proves stable under sustained load |
| **EIP-7702** (scoped session keys) | Frontend (currently `@zerodev/permissions`) | Native EOA session keys would simplify the provider layer. Blocked on 7702 finalization + wallet support |
| **ERC-7710 / ERC-7715** (delegated permissions) | Frontend | Both still Draft as of mid-2026. MuHaven wires through `@zerodev/permissions` abstractions, not raw 7715 RPC, until Last Call |
| **ERC-8004** (agent identity) | Agent-to-agent (planned) | Combines with x402; A2A Agent Cards already used for discovery in the agentic layer |

### Deliberate deviations

**fhERC-20 vs ERC-20 vs ERC-7984 (confidential ERC-20 draft).** `MuHavenToken` is an fhERC-20 — balances are `euint128`, transfers take `InEuint128` encrypted inputs, all state mutations go through `FHE.add` / `FHE.sub` / `FHE.select`. Deviates from plain ERC-20 in the obvious ways (no plaintext `balanceOf`, no plaintext `Transfer(from,to,amount)` event). Differs from the early ERC-7984 draft in type choice (`euint128` vs `euint64`) and in using permit-based `decryptForView` rather than sealed outputs. Type difference is driven by USDC accounting room — `euint128` accommodates aggregate RWA positions comfortably; `euint64` is tight at ~18.4T with 6 decimals.

**Pull-based per-epoch yield vs ERC-2222 dividends.** ERC-2222 computes `dividendOf(account)` from a running per-share accumulator, which leaks balance information via the accumulator interaction. MuHaven's `YieldSnapshot` keeps each holder's snapshot balance encrypted and computes the share at claim time via cleartext `ratePerShare`. The cleartext rate is by-design (RWA per-share rates are conventionally published off-chain) and was the architectural break that escaped the cofhe TN chain-length cap on the original `FHE.div(encYield, encTotalSupply)` model.

**Silent-fail events vs traditional revert-on-error.** Standard EVM contracts revert on authorization failures. MuHaven contracts intentionally emit success events (`Purchased`, `Redeemed`, `EpochClaimed`) unconditionally so a wrong-caller / cap-exceeded / insufficient-balance attempt is indistinguishable on-chain from a successful one. Integrators must verify mhUSDC movement via `ConfidentialTransfer` events — documented in every consumer (SDK caveats, backend poller, this doc).

---

## Deployment

### Setup

```bash
npm install -g pnpm
pnpm install
pnpm compile
```

### Deploy scripts

The platform deploy ships 11 singleton contracts; the per-token wizard scripts ship the token triple (`MuHavenToken` + `MuHavenTreasury` + `RedemptionQueue`) + register + bind compliance modules.

```bash
# Platform deploy (writes deployments/arb-sepolia-v2.json)
pnpm run deploy:v2:testnet                           # MUHAVEN_ENV=prod
pnpm run deploy:v2:testnet:stage                     # MUHAVEN_ENV=staging
pnpm run deploy:v2:local                             # local Hardhat

# Per-token onboarding (preset env files at scripts/env/<symbol>.env)
bash scripts/onboard-token.sh cetes
bash scripts/onboard-token.sh usyc

# Operator helpers
MUHAVEN_ENV=prod \
MUHAVEN_TOKEN_SYMBOL=CETES \
MUHAVEN_INITIAL_NAV=66985 \
pnpm hardhat run scripts/unpause-token.ts --network arb-sepolia

# End-to-end yield epoch driver
MUHAVEN_ENV=prod \
MUHAVEN_TOKEN_SYMBOL=CETES \
MUHAVEN_TOTAL_YIELD=50000000 \
MUHAVEN_RATE_PER_SHARE=200000 \
pnpm hardhat run scripts/run-yield-epoch.ts --network arb-sepolia

# Upgrades (transparent-proxy admin)
MUHAVEN_ENV=prod pnpm hardhat run scripts/upgrade-stable.ts --network arb-sepolia
MUHAVEN_ENV=prod pnpm hardhat run scripts/upgrade-yield-snapshot.ts --network arb-sepolia
MUHAVEN_ENV=prod pnpm hardhat run scripts/grant-trusted-payer.ts --network arb-sepolia

# Legacy (read-only artifact)
pnpm run deploy:testnet                              # writes deployments/arb-sepolia.json
```

### Deploy order (platform deploy — `scripts/deploy-v2.ts`)

1. `MuHavenStable` (proxy)
2. `ClaimTopicsRegistry`, `TrustedIssuersRegistry`, `MuHavenIdentityRegistry` (proxies)
3. `ModularCompliance` (proxy)
4. `TokenRegistry` (proxy)
5. `InvestorRegistry` (proxy)
6. `MuHavenSubscription` (proxy) + `setIdentityRegistry` + `setModularCompliance`
7. `YieldSnapshot` (proxy)
8. `IssuerControlledOracle` (proxy)
9. `ChainlinkFunctionsOracle` (proxy)
10. **Wiring**: `stable.setTrustedPayer(yieldSnapshot, true)` (folded into the deploy — fresh deploys are claim-ready by construction)
11. Write `deployments/arb-sepolia-v2.json`

### Deployed addresses (Arb Sepolia · production)

See [`deployments/arb-sepolia-v2.json`](../deployments/arb-sepolia-v2.json) for the authoritative list. Deployer `0xe11E83398C33A37CaC02C01c43F14A7f95876986`. All proxies + implementations verified on Arbiscan. The 11 platform-singleton proxy addresses are listed in the Contract overview § above; proxy addresses are stable across implementation upgrades.

**Active RWA tokens (11)** — each with its own `MuHavenToken` / `MuHavenTreasury` / `RedemptionQueue` triple wired to the platform `YieldSnapshot`:

| Symbol | Name | `MuHavenToken` proxy |
|---|---|---|
| `USYC` | Circle USYC | `0x1d6C140204F21835F1AF2A0615826A333827d946` |
| `BUIDL` | BlackRock USD Liquidity Fund | `0xD43c1eB475616c8659346d6dEbE34fcb7A331F24` |
| `CETES` | Etherfuse CETES | `0xF3945c52DB79eBc6BFEA1dc460Ead77D70858B43` |
| `EUTBL` | Spiko EU T-Bills MMF | `0xd6da55d273b174f102911c7389102eB05f7963A0` |
| `syrupUSDC` | Syrup USDC | `0x4a4dEeEA9fF30015899C8821e2ebc49C418fbc38` |
| `USDY` | Ondo U.S. Dollar Yield | `0x631FB36a4311566395B236ad9BE4701b5256f35F` |
| `ONyc` | OnRe Tokenized Reinsurance | `0x66Ec340237bBb069e59d7a38bD9973228facF7E8` |
| `MUon` | Micron Technology (tokenized) | `0x06C50E3a710Dc8C2801e38d4942898c7af8b02CB` |
| `NVDAon` | NVIDIA (tokenized) | `0x9D37fF9747F0fe864eC899B04a641EDe309d1764` |
| `STRCx` | Strategy Variable xStock | `0xf5f30Fcdc7808AC4e0a5b713637Fd59C3A1B8487` |
| `TSLAx` | Tesla xStock | `0x797b9a2ec6F752B791DcE2f721Ad51Da68074Ed3` |

The original `TBILL1` (`0x8D77cCf0a3a56c976a7DEAe59aF1D27f27407b0D`) and `GOLD1` (`0x93e813e924A96441181A01171Cd1E20FaaC87AcF`) tokens are **retired** (read-only; not featured in the UI).

**External (Arb Sepolia):** Circle USDC `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`; retired legacy ConfidentialUSDC `0x6b6e6479b8b3237933c3ab9d8be969862d4ed89f`; Chainlink Functions Router `0x234a5fb5Bd614a7AA2FfAB244D603abFA0Ac5C5C`.

### Testing

```bash
pnpm test                                              # All tests (~786 cases, mock FHE)
pnpm test test/MuHavenSubscriptionPurchase.test.ts     # Single test file
pnpm test test/MuHavenSdkV2.integration.test.ts        # SDK integration suite
```

~786 Hardhat cases (mock FHE). Backend + SDK integration suites run separately (`pnpm test test/MuHavenSdkV2.integration.test.ts`).

---

## References

- [ARCHITECTURE.md](./ARCHITECTURE.md) — system layers, contract topology, data flows, integration points
- [SDK.md](./SDK.md) — `@muhaven/sdk` API reference for the contracts above
- [AGENT_DESIGN.md](./AGENT_DESIGN.md) — four-surface agentic layer + tiered autonomy + threat model
- [THREAT_MODEL.md](./THREAT_MODEL.md) — privacy boundary, side-channel resistance, ZK/TEE/MPC comparison
- [ISSUER_MODEL.md](./ISSUER_MODEL.md) — supply-side mechanics: token onboarding wizard, yield epoch lifecycle
- [TOKEN_LIFECYCLE.md](./TOKEN_LIFECYCLE.md) — four-state lifecycle (Active / Paused / Winding Down / Archived), design spec
- [`development/DEV_WAVE_3_5/ADR_LOG.md`](../development/DEV_WAVE_3_5/ADR_LOG.md) — full ADR catalog (D1–D9 + ADR-010 through ADR-050)
- [`deployments/arb-sepolia-v2.json`](../deployments/arb-sepolia-v2.json) — authoritative deployed addresses
