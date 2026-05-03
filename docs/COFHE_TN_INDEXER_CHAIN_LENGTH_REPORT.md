# Cofhe Threshold Network — Decrypt Stalls on Cross-Tx Ancestry

> **Filed:** 2026-04-29 (initial — chain-length hypothesis)
> **Major revision:** 2026-05-04 (corrected model after empirical
> evidence; renamed to reflect actual mechanism)
> **Filed by:** MuHaven (Wave 3.5 / Phase 8 staging cutover, then
> Wave 3.5 / Phase 9.A audit-handle slate, then Wave 3.5 / Phase 9.B
> Option A architectural change).
>
> **Purpose:** Reproducible report for the Fhenix / cofhe team. Across
> three rounds of investigation we confirmed that on Arbitrum Sepolia
> testnet, certain ctHashes never advance past TN's "ctHash known but
> request not ready" state. The original "single chain-depth threshold"
> hypothesis turned out to be wrong; the corrected model is "ancestry
> resolution stalls on specific upstream nodes" (most often
> `FHE.div` over an aggregate denominator). We've shipped a contract-
> level workaround (Option A — replace on-chain `encRatio` with an
> issuer-provided cleartext per-share rate) that sidesteps the stall
> at the cost of disclosing per-share yield rates publicly. This
> document explains the full investigation so cofhe can correlate
> against TN-internal logs and ideally lift whatever's stalling.
>
> **Network:** Arbitrum Sepolia (chain id 421614).
> **Cofhe SDK version:** `@cofhe/sdk@0.5.1`.
> **Cofhe contracts version:** `@fhenixprotocol/cofhe-contracts@0.1.3`.
> **TaskManager:** `0xea30c4b8B44078Bbf8a6Ef5b9F1eC1626c7848D9`.
> **Verifier signer:** `0x013a…e71` (matches per
> `scripts/probe-cofhe-encrypt.ts` output `[OK]`).
> **MuHaven repo:** muhaven (Wave 3.5).
> **Affected contracts:** `MuHavenStable` (mhUSDC wrapper),
> `YieldSnapshot`, `MuHavenSubscription`, `MuHavenToken`.
> **Affected user (recent reproducer):**
> `0x522a04d74d61cab004a6ac8efb4abdc87d46b0fa` on staging.

---

## Executive summary (read this if nothing else)

After three rounds of investigation including comprehensive Arbiscan
receipt decoding, the failure mode we've been chasing for a month is:

**A specific ctHash sits in the cofhe TN testnet's "request not
ready" state indefinitely (HTTP 204 on `/v2/sealoutput`). Once one
ctHash is stuck, every descendant ctHash that depends on it
inherits the stuck state via TN's ancestry-resolution path.**

The original hypothesis was "TN refuses handles whose FHE op-chain
crosses some depth threshold." Empirical evidence (a 6-tx wrap →
buy → buy → buy → wrap → transfer sequence with successful post-tx
mhUSDC reveal, vs a 3-op claim tx producing an unresolveable handle)
disproved this. Per-tx local chain length is bounded fine; cross-tx
ancestry resolution is where it breaks down.

The stuck nodes share two structural traits:
1. **`FHE.div` operations on aggregate-fan-in denominators**
   (e.g. `encRatio = div(encTotalYield, sum-of-investor-balances)`).
2. **Cross-contract reference graphs** (e.g.
   `mul(snapshotBalance@MuHavenToken, encRatio@YieldSnapshot)`).

We've worked around it by re-architecting the yield distribution
contract so the multiplicand is an issuer-provided cleartext rate
instead of an on-chain encrypted ratio. This breaks the privacy
boundary on per-share yield rate (now publicly readable) but
preserves per-investor balance privacy. **Filed for cofhe team
visibility** because:
- The TN-side fix would let us restore full encrypted ratio.
- Other Fhenix integrations are presumably hitting the same wall.

---

## Reproduction history

### Round 1 — Phase 8 (2026-04-29): "trustedPayout bypass"

**Initial trigger:** investor's post-claim mhUSDC reveal returned
indefinite HTTP 204 polls. Tx receipt showed an 8-op FHE chain in
`YieldSnapshot.claimYield`:

```
mul → cast → sub → lte → trivialEncrypt → select → sub → add
```

The middle 3 ops (`lte → trivialEncrypt → select`) came from
`MuHavenStable._doTransfer`'s `_silentFailBound(balance, amount)`
check on the wrapper's transfer-from-snapshot leg.

**Hypothesis:** TN has a per-tx FHE op-chain length threshold of
~5-7. The 8-op chain crosses it.

**Fix (ADR-046):** introduced `MuHavenStable.trustedPayout(to,
encAmount, ephemeralEOA)` — a privileged surface that bypasses
`_silentFailBound` (relies on per-epoch conservation in
`YieldSnapshot` to guarantee the snapshot's float covers every
legitimate claim). Restricted via owner-managed `_trustedPayer`
mapping. Cuts the wrapper-side FHE op count from 5 → 2 and the
total claim-tx chain from 8 → 5.

**Result:** post-claim mhUSDC reveal worked again. Hypothesis
appeared confirmed. Memory entry written:
`project_cofhe_tn_chain_length_cap` — "5 works, 8 doesn't."

### Round 2 — Phase 9.A (2026-05-04 session 1): "5 ops also fails on fresh kernels"

**Re-trigger:** user reported the same symptom on a fresh-kernel
investor. Tx receipt showed exactly 5 TaskManager events in
`claimYield` (matching ADR-046's expected reduced chain). Yet the
post-claim mhUSDC handle still 204s.

**Round 1 audit-handle (`encShare64`):** added `FHE.allow(encShare64,
msg.sender) + ephemeralEOA` so the investor could decrypt the per-
claim amount via the `YieldClaimed` event. encShare64 = `cast(mul(
balance, encRatio))` ≈ 2-3 op local chain. **Failed.** Hypothesis:
encShare64 inherits encRatio's deep ancestry through mul.

**Round 2 audit-handle (`encRatio`):** added grants on `e.encRatio`
and rewrote the frontend `/activity` Decrypt path to fetch encRatio
+ snapshotBalance separately and multiply locally. **Also failed.**

**Hypothesis at end of Round 2 (still wrong):** "encRatio's chain
depth (max(encYCanonical, encTotalSupply) + 1) crosses TN's
threshold even though it's structurally short within fundEpoch's
tx." Memory updated with Round 2 evidence.

### Round 3 — Phase 9.A (2026-05-04 session 2): "encTotalYield + encTotalSupply ACL"

**Approach:** add ACL grants on `e.encTotalYield` (depth ~3 from
issuer's `InEuint128` input — wrapper-free, no aggregate fan-in)
AND `e.encTotalSupply`. Frontend reads three handles, computes
share = `floor(balance × totalYield / supply)` locally.

**Status when filed:** committed to develop, awaiting deploy +
verification. Likely to work for the audit-trail Decrypt path
(`/activity`) but cannot fix the LIVE post-claim mhUSDC reveal
on `/cash` + `/portfolio` — that handle's ancestry is fixed by
the wrapper's `add` op and unavoidably traces through
`encShare64 → mul(balance, encRatio)`.

### Round 4 — Phase 9.A (2026-05-04 session 3): empirical correction

**User-provided evidence:**
[user `0x522a04d74d61cab004a6ac8efb4abdc87d46b0fa`](https://sepolia.arbiscan.io/token/0x6b6e6479b8b3237933c3ab9d8be969862d4ed89f?a=0x522a04d74d61cab004a6ac8efb4abdc87d46b0fa)
ran a 6-tx sequence:

| # | Tx | TaskManager events | Local chain to mhUSDC |
|---|---|---|---|
| 1 | [Wrap](https://sepolia.arbiscan.io/tx/0xfeb5dbfa4c84010a41004bbc3cb7e01aba042eb9621a3ddfb06b12305e7e4cd8) | 6 | 0 (first-mint, direct assignment) |
| 2 | [Buy A](https://sepolia.arbiscan.io/tx/0xe6b139bfa092e2fc76744d14542fd8ef49468d7be3c5d9eee252baccf78ad521) | 16 | 7: `lte → select → mul → cast → lte → select → sub` |
| 3 | [Buy B](https://sepolia.arbiscan.io/tx/0x9365a316bfc28771124b9c89e8f1f28ce109e2558c75ba95263c7aa68a95e12e) | 16 | 7 |
| 4 | [Buy C](https://sepolia.arbiscan.io/tx/0x08661c21057ef4dad2aca6b5a73225aa0fea4150117a65bad43c8d2b1502b9cb) | 16 | 7 |
| 5 | [Wrap 2](https://sepolia.arbiscan.io/tx/0x2a7c535b5e2dcd43570b5c1280aeaff670276fc0323636d7272b442642ac0669) | 7 | 1 (`add` only) |
| 6 | [Transfer Token](https://sepolia.arbiscan.io/tx/0x6e363f8517aaa8599a46b1e288690603c5f33658b9e05d68228553597a86ad74) | 5 | 0 (different token) |

**Empirical fact:** user can decrypt their mhUSDC balance after this
sequence. Multiple per-tx chains of length 7 are fine.

**Failing claim tx for comparison:**
[`0xfb8a28fdacd23c2b7629f5f639f8bce02c828a0c134332eb740e1988b2fff71a`](https://sepolia.arbiscan.io/tx/0xfb8a28fdacd23c2b7629f5f639f8bce02c828a0c134332eb740e1988b2fff71a)
— 5 events:

```
mul(snapshotBalance, encRatio) → encShare128
cast(encShare128) → encShare64
sub(encRemaining, encShare64) → newRem
sub(snapshotFloat, encShare64) → snapshot's new mhUSDC balance
add(userMhUSDC, encShare64) → user's NEW mhUSDC
```

Local chain to new mhUSDC: 3 ops. Way shallower than buy's 7. Yet
this handle 204s.

**Conclusion:** chain-depth model is wrong. The discriminator is
something about `encRatio`'s ancestry, not raw chain length.

`encRatio = FHE.div(encYCanonical, encTotalSupply)` from `fundEpoch`.
`encYCanonical` is depth ~3 (3 cast ops on issuer's
`InEuint128 calldata` — no fan-in). `encTotalSupply` is the
running-sum accumulator from `snapshotBatch` over every snapshotted
holder's balance handle (each of which has wrapper-tainted
ancestry through the investor's `Subscription.purchase`). The
`FHE.div` on top of an aggregate-fan-in denominator appears to be
where TN gets stuck.

---

## Corrected model

For TN to materialize a handle's plaintext, it walks the dependency
DAG back to leaves (input verifies + trivials). Most ancestries
resolve fine. **Some specific upstream nodes get stuck — TN can't
or won't produce their plaintext within the SDK's polling window.
Once one ancestor stalls, every descendant inherits the stall.**

The stuck nodes we've identified empirically share two traits:

1. **`FHE.div` on aggregate-fan-in denominators.** `encRatio`
   computed via `div(encYCanonical, encTotalSupply)` where
   `encTotalSupply` is the result of N `FHE.add` accumulations
   across N investor balances.

2. **Cross-contract reference graphs.** Operations like
   `mul(handle@ContractA, handle@ContractB)` where the two operands
   come from independent multi-tx histories on different contracts.

Other handle shapes that work fine despite similar-looking depth:

- `MuHavenToken._balances[investor]` (depth ~9 cumulative through
  Subscription's silent-fail chain) — decrypts fine via
  `/portfolio`.
- `MuHavenStable._balances[user]` after multiple wraps + buys —
  user's empirical evidence (above).
- `_silentFailBound`-derived handles in pre-claim mhUSDC mutations.

So the question for cofhe is: **what's structurally different about
encRatio that puts it in the stuck set?** Our hypotheses are
ordered by likelihood:

- (a) **`FHE.div`-specific** — the divide op might have a
  different processing path on the TN side (rounding, modular
  inverse, etc) that hits an edge case under certain operand
  shapes.
- (b) **Aggregate-fan-in resolution** — TN may parallelize
  ancestry resolution; if the aggregate accumulator's parallel
  sub-resolution hits a back-pressure / queueing limit, the parent
  request stalls.
- (c) **Cross-contract handle correlation** — TN may treat
  cross-contract references differently in its scheduler; a
  combinatorial blowup of "which contract's permit binds which
  request" might land an op outside the indexer's normal path.
- (d) **TN testnet rate limiting** — the affected handles might be
  produced during high-traffic windows and slot into a permanent
  "low priority" queue.

We don't have visibility into TN's internals to test these. The
on-chain evidence supports (a)+(b) most strongly: the stuck handles
all involve `FHE.div` on multi-fan-in denominators, while every
non-div handle in the receipts decrypts cleanly.

---

## What MuHaven shipped as a workaround (Phase 9.B / Option A)

We accepted a privacy trade-off and re-architected `YieldSnapshot`
to never need `encRatio` decryption:

**Before** (failing post-claim mhUSDC):
```solidity
// fundEpoch:
e.encRatio = FHE.div(encYCanonical, e.encTotalSupply);

// claimYield:
encShare128 = FHE.mul(encBalance, e.encRatio);
encShare64  = FHE.asEuint64(encShare128);
trustedPayout(investor, encShare64, eph);
// → _balances[investor] = add(prev, encShare64)
//   (ancestry: encShare64 ← mul ← encRatio ← div ← encTotalSupply ← N×add ← per-investor balances)
```

**After Option A** (working post-claim mhUSDC):
```solidity
// fundEpoch:
e.ratePerShare = ratePerShare;  // cleartext uint128, issuer-supplied off-chain

// claimYield:
euint128 trivialRate = FHE.asEuint128(uint256(e.ratePerShare));  // depth 1 trivial
encShare128 = FHE.mul(encBalance, trivialRate);
encShare64  = FHE.asEuint64(encShare128);
trustedPayout(investor, encShare64, eph);
// → _balances[investor] = add(prev, encShare64)
//   (ancestry: encShare64 ← mul ← {encBalance + depth-1 trivial}
//    — the trivial has no aggregate fan-in)
```

The `FHE.mul(encBalance, trivialRate)` produces a handle whose
ancestry is `max(encBalance, trivialRate) + 1`. encBalance has its
own multi-tx history but resolves fine on its own (TBILL1 share
balance is empirically decryptable). The trivial is a depth-1 leaf.
**No `encRatio`, no `encTotalSupply`, no aggregate fan-in.**

**Privacy cost:** per-share yield rate (`ratePerShare = floor(
totalYield / totalSupply)`) is now publicly readable on-chain. For
RWAs this is conventionally OK — TBILL APY, dividend rates, gold
lease rates are published off-chain anyway. **Per-investor
balances and per-claim shares stay encrypted.**

**Conservation:** still holds. `sum(claims) = ratePerShare × sum(
balance_i) = ratePerShare × totalSupply ≤ totalYield` (issuer
must self-report `ratePerShare ≤ floor(totalYield / totalSupply)`;
honest issuer satisfies this trivially since it's their own money).

---

## What we'd love from cofhe

1. **Telemetry / log access** for one specific stuck handle so we
   can correlate the on-chain TaskCreated event with TN's
   processing state. If you can tell us "ctHash X is queued
   indefinitely because Y," we can structure future contracts to
   avoid Y.

2. **Public guidance on `FHE.div` performance characteristics.**
   Is divide ABNORMALLY slow on the testnet TN compared to other
   binary ops? Is there a known back-pressure regime?

3. **Aggregate-fan-in resolution model.** When a handle's
   denominator has N parallel `FHE.add` accumulators in its
   ancestry, does TN's resolver fork all N or serialize?

4. **Mainnet TN expectations.** The user-facing privacy story is
   compromised by Option A. We'd like to revert to encrypted
   `encRatio` on mainnet. Is mainnet's TN expected to handle the
   same handles testnet stalls on?

5. **Hard ancestry budget, if any.** Is there a documented cap
   (number of ops, number of cross-contract references, fan-in
   factor) we should design contracts around? The empirical
   evidence suggests the cap is data-shape-dependent rather than a
   simple number.

---

## How to reproduce

1. **Deploy MuHaven Wave 3.5 contracts on Arb Sepolia.** Repo
   includes `scripts/deploy-v2.ts` for end-to-end deploy.
2. **Onboard a token** via `scripts/onboard-token.ts`.
3. **Snapshot + fund an epoch** with the pre-Round-1 contract code
   (commit before `ADR-046`'s `trustedPayout`):
   ```
   MUHAVEN_ENV=staging \
   MUHAVEN_TOKEN_SYMBOL=TBILL1 \
   MUHAVEN_TOTAL_YIELD=1000000000 \
   pnpm hardhat run scripts/run-yield-epoch.ts --network arb-sepolia
   ```
4. **Investor claims** via the dashboard or directly via the SDK's
   `YieldSnapshotClient.claimYield`.
5. **Investor's mhUSDC reveal 204s** indefinitely on
   `/v2/sealoutput`.

Or pull the failing claim tx
`0xfb8a28fdacd23c2b7629f5f639f8bce02c828a0c134332eb740e1988b2fff71a`
directly and observe TN's response on the resulting `_balances[
investor]` ctHash.

The diagnostic recipe (extract TaskManager events, walk the DAG,
identify the stuck node) is in
`development/DEV_WAVE_3_5/COFHE_TN_DIAGNOSTIC_GUIDE.md` in the
MuHaven repo.

---

## Why this report matters

We've burned significant engineering time chasing the wrong
hypothesis (chain-depth threshold) for a month. Three contract
upgrades, one architectural re-design. The actual mechanism
(ancestry-resolution stall on specific upstream nodes) was only
visible after detailed tx-receipt decoding.

**For Fhenix:** other integrations using FHE-mediated proportional
math (yield distributions, ratio computations, vote-weight
aggregations) likely hit the same wall. Documenting it publicly
would save weeks.

**For us:** Option A unblocks Wave 3.5 ship. If cofhe TN's
behavior changes (mainnet, testnet improvements), we'd revert to
encrypted `encRatio` to restore the privacy boundary. Owner-toggle
or epoch-config flag could let us run both paths side-by-side.

---

## Contact

Repo: muhaven (private at time of filing; happy to grant cofhe
team read access on request).
Author: hasto (`miloshaku@gmail.com`).
Commits referenced:
- `5ec8317` — Phase 8 / ADR-046 trustedPayout
- `e3d748e` — Round 1 audit handle (encShare64)
- `5436196` — Round 2 audit handle (encRatio decoupled-decrypt)
- `b83b820` — Round 3 audit handle (encTotalYield + encTotalSupply)
- TBD (Phase 9.B) — Option A architectural change.

For TN-side correlation we can provide:
- Specific ctHashes that are stuck.
- Tx hashes that produced them.
- User addresses with both working and failing handles for
  ancestry comparison.
- Repro scripts.
