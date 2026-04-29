# Cofhe Threshold Network — Indexer chain-length pathology on Arb Sepolia

> **Filed:** 2026-04-29 by MuHaven (Wave 3.5 / Phase 8 staging cutover).
>
> **Purpose:** Reproducible report for the Fhenix / cofhe team. We hit
> what looks like an undocumented hard cap on the FHE operation chain
> length the cofhe TN testnet indexer will register. Long chains
> produce ctHashes that the TN silently refuses to seal-output —
> investors see indefinite HTTP `204` polls on `/v2/sealoutput` and
> the SDK errors `SEAL_OUTPUT_FAILED ... 300000ms without receiving
> request_id` after the 5-minute timeout. We worked around it by
> shortening the chain (`MuHavenStable.trustedPayout` bypass that
> skips `_silentFailBound`); the underlying TN behavior would be good
> to understand and ideally lift.
>
> **Network:** Arbitrum Sepolia (chain id 421614).
> **Cofhe SDK version:** `@cofhe/sdk@0.5.1`.
> **Cofhe contracts version:** `@fhenixprotocol/cofhe-contracts@0.1.3`.
> **TaskManager:** `0xea30c4b8B44078Bbf8a6Ef5b9F1eC1626c7848D9`.
> **Verifier signer:** `0x013a…e71` (matches per
> `scripts/probe-cofhe-encrypt.ts` output `[OK]`).

---

## TL;DR

`MuHavenStable.transferFrom(from, to, encAmount, fromEph, toEph)`
calls the wrapper's internal `_doTransfer`, which applies a
`_silentFailBound(_balances[from], encAmount)` check (FHE.lte +
FHE.asEuint64(0) + FHE.select). When invoked from
`YieldSnapshot.claimYield`, the resulting tx-level FHE op chain is
**8 ops**:

```
FHE.mul (encBalance × encRatio)
FHE.asEuint64 (cast 128 → 64)
FHE.sub (_encRemaining decrement)
FHE.lte (silent-fail bound)
FHE.asEuint64(0) (silent-fail zero constant — emitted as `trivialEncrypt`)
FHE.select (silent-fail clamp)
FHE.sub (sender balance decrement, snapshot's float)
FHE.add (recipient balance increment, investor's mhUSDC)   ← target ctHash
```

The recipient's resulting `_balances[investor]` ctHash is **never
indexed by the TN sealoutput service**. Every subsequent decrypt
attempt against that ctHash polls `/v2/sealoutput` and gets `204` until
the SDK times out at 5 minutes.

A shorter chain (5 ops) — same logical flow but skipping the 3
`_silentFailBound` ops — registers cleanly and decrypts within seconds.

The trigger appears to be the chain length, not any specific op or
caller pattern.

---

## Reproduction

Concrete failing tx on Arb Sepolia staging:

- **Tx hash:** `0xdef729d1afab7481dafad82e9f0de82c59f939c378e817503aca88d80d318c4e`
- **Block:** 264241447
- **Receipt status:** `0x1` (Success)
- **Caller (kernel SCA):** `0x2E7bFa06c1D44E9705498359612EdC35ca25cb9B`
  (ZeroDev kernel via EntryPoint `0x0000000071727De22E5e9d8BAf0edAc6f37da032`)
- **YieldSnapshot proxy:** `0x6d5C0E40f53c702CDc4923acccbdD6F45cBD3E29`
- **MuHavenStable proxy:** `0xf7f6Db67E06923f458F8a465160f53b2486F77Fd`

Receipt log dump (TaskManager events shown — full receipt available
on Arbiscan):

| Log idx | Op | Output ctHash (truncated) |
|---|---|---|
| 2 | `mul` | `0x74b07d63…0500` |
| 3 | `cast` | `0x9438249d…0500` |
| 4 | `sub` | `0xed949a41…0500` |
| 5 | `lte` | `0xf4fdd12a…0500` |
| 6 | `trivialEncrypt` | `0x43662edd…0500` |
| 7 | `select` | `0x35f99175…0500` |
| 8 | `sub` | `0x4ebfce8b…0500` |
| 9 | `add` | `0xea0b350c75b3c9551cd3e8b5a9e2699ebcc29ed9f2165474709c30169fa90500` ← **fails to index** |
| 10 | (Wrapper `Transfer` event) | n/a |

After this tx confirms, calling `MuHavenStable.confidentialBalanceOf(0x2E7bFa…)`
returns the ctHash from log 9 (`0xea0b350c…fa90500`) — confirming the
contract storage is updated correctly. ACL grants are also correct
(verified via mock fixture parity + on-chain calldata trace —
`FHE.allow(handle, eph)` is called inside the wrapper's `_doTransfer`).

But: a permit-decrypt request for that ctHash via cofhe SDK
(`client.decryptForView(ctHash, FheTypes.Uint64).execute()`) hangs
on a stream of HTTP 204 responses from the TN's
`/v2/sealoutput` endpoint until the SDK's `SEAL_OUTPUT_TIMEOUT_MS`
(5 min) elapses. Then it throws:

```
CofheError: sealOutput submit retried without receiving request_id
for 300000ms
```

Reproduces consistently across:
- Multiple kernel addresses (sacrificial + freshly-registered).
- Multiple yield epochs on the same YieldSnapshot.
- Sufficient issuer mhUSDC float (preflight-wrapped just before
  `fundEpoch` so the wrapper's `_doTransfer` did not silent-fail —
  on-chain `Wrap` event verified, balance trace-checked).
- A 1-hour wait between claim tx and decrypt attempt (well past TN
  propagation lag — the SDK timeout itself is only 5 min).

Decrypt succeeds in seconds when the ctHash was produced by a
**shorter chain**:
- `MuHavenStable.wrap(encAmount, eph)` produces a 1-op chain
  (`FHE.add` in `_mintInternal`) — always indexes fine.
- Investor-initiated `MuHavenStable.transfer(to, encAmount, eph)`
  produces a 5-op chain (`FHE.lte + asEuint64(0) + select + sub + add`)
  via `_silentFailBound + _doTransfer` — also indexes fine.
- The 8-op chain above (snapshot-mediated path with extra `mul + cast +
  sub` upstream) is the only failing case in our test matrix.

We did not narrow further — could not pin the exact threshold (it's
somewhere between 5 ops working and 8 ops failing). Did not
investigate whether the issue is op count, total chain depth, total
bytecode complexity, or some other heuristic.

---

## Diagnostic chain (what it ISN'T)

We chased and ruled out, in order:

1. **ACL denial / missing eph grant.** Pre-fix on our side, the
   investor's `ephemeralEOA` was not granted on the post-claim handle
   (legacy `confidentialTransfer(address,uint256)` shim path that
   ignored `ephemeralEOA`). Symptom was HTTP `403` stream, fixed by
   switching to the modern split-grant `transferFrom` overload. After
   the fix, `403` stopped — replaced by `204` stream. The grant is
   correct end-to-end (verified via mock ACL probe under hardhat
   fixtures + on-chain calldata trace).

2. **Stale ephemeral EOA across reload.** `ephemeralEOA` regenerates
   on browser reload (in-memory by design), but the wrapper's
   `refreshDecryptGrant(eph)` is supposed to handle this. Verified:
   refresh tx confirms, ACL grant lands on-chain — but decrypt still
   `204`s.

3. **TN propagation lag.** Waited 1 hour after the claim tx. SDK still
   `204`-times-out at 5 min.

4. **Cofhe TN globally unreachable / verifier mismatch.**
   `scripts/probe-cofhe-encrypt.ts` (encrypt → recover-signer
   round-trip against the live verifier) returns `[OK]` consistently.
   We had a separate verifier-signer drift issue earlier this month
   (resolved by upgrading `@cofhe/sdk` to 0.5.1 — older SDK's TFHE 1.4
   ciphertexts were rejected by the upgraded TFHE 1.5.3 verifier).
   The probe script confirms that's not the current issue.

5. **MuHavenToken (per-RWA) decrypt also stuck?** No — TBILL1
   `decryptForView(_balances[investor])` works in seconds even after
   the failing claim tx. The breakage is scoped to MuHavenStable
   handles, not MuHavenToken handles. Same TN, same kernel, same
   block — the only difference is the contract that wrote the handle.

6. **Fresh kernel?** Yes, repro'd on a brand-new kernel (no prior
   mhUSDC state, no inherited "tainted" handles).

7. **Subsequent operations on the affected slot?** A fresh `wrap`
   (1 PUSDC → 1 mhUSDC) post-claim creates a new ctHash via
   `FHE.add(post_claim_handle, wrap_amount)`. That ctHash is ALSO
   stuck on `204`s — derivatives of an unindexed handle inherit the
   brokenness. The kernel's mhUSDC slot becomes effectively
   un-decryptable until the next time we destabilize the chain (we
   haven't found a way to recover; sacrificial kernels stay broken).

The only remaining variable was chain length / structure of the FHE
op DAG produced by `_doTransfer`. We pivoted to a workaround instead
of further narrowing.

---

## Workaround we shipped

`MuHavenStable.trustedPayout(to, encAmount, ephemeralEOA)` — a new
external function on our wrapper that bypasses `_silentFailBound`.
Restricted to addresses pre-registered via `setTrustedPayer`
(owner-only). `YieldSnapshot.claimYield` switched from
`IMuHavenStable.transferFrom` to `IMuHavenStable.trustedPayout`.

Post-fix tx flow's FHE op chain (5 ops):

```
FHE.mul (encBalance × encRatio)
FHE.asEuint64 (cast 128 → 64)
FHE.sub (_encRemaining decrement)
FHE.sub (sender balance decrement)
FHE.add (recipient balance increment)   ← decrypts in seconds
```

The skipped 3 ops were `FHE.lte + FHE.asEuint64(0) + FHE.select`
(the silent-fail bound). Per-epoch conservation in our YieldSnapshot
contract guarantees the snapshot's mhUSDC float covers every
legitimate claim, so the bound is structurally unnecessary on this
leg. We documented the skip in our internal ADR-046 + memory.

Verified end-to-end: investor wraps 7 USDC → 7 mhUSDC, buys 3 TBILL1
worth $3 → mhUSDC = $4. Claims yield → mhUSDC = $4.02. The $0.02
yield landed correctly through the 5-op chain. Decrypt succeeds in
seconds; no `204` stream.

Trade-off: lost defense-in-depth from the silent-fail bound on this
specific call site. Acceptable for a contract-mediated path with
guaranteed conservation; not a pattern we can use for direct EOA
P2P transfers.

---

## What we'd love your help with

1. **Is this a known limitation?** If so, please point to docs / changelog.
2. **What's the actual rule?** Is it op count, chain depth, total
   computational cost, or something else? Knowing the threshold lets
   us design within it instead of guess-and-check.
3. **Will it be fixed?** We'd prefer to retire `trustedPayout` and use
   the cleaner `transferFrom` path once the indexer handles longer
   chains. Tracked internally as G-D9 backlog item (3-month revisit).
4. **Is there a workaround we missed?** E.g., a TN-side flush /
   reindex API that recovers tainted handles without redeploying.
5. **Is this Arb-Sepolia-testnet-specific or shared with mainnet?**
   We're heading to Arb One mainnet soon; would like to know if the
   same chain-length cap exists there.

We're happy to provide additional repro txs, op-chain dumps, or run
custom probes against the TN if it'd help isolate the issue.

---

## References

- **Ours:** `development/DEV_WAVE_3_5/PHASE8_BLOCKER_YIELD_CLAIM_DECRYPT.md`
  (full diagnostic narrative across 4 sessions, ~17h of investigation),
  `development/DEV_WAVE_3_5/ADR_LOG.md > ADR-045 + ADR-046` (the
  contract-side fix arc).
- **Failing tx:** `0xdef729d1afab7481dafad82e9f0de82c59f939c378e817503aca88d80d318c4e`
  on Arb Sepolia.
- **Failing ctHash:** `0xea0b350c75b3c9551cd3e8b5a9e2699ebcc29ed9f2165474709c30169fa90500`
  (from the `FHE.add` at log 9 of the failing tx — this is what
  `MuHavenStable.confidentialBalanceOf(0x2E7bFa…)` returned post-tx
  and what cofhe SDK was unable to seal-output).
- **Working ctHash for comparison:** investor's TBILL1 balance handle
  on `MuHavenToken` (per-RWA token, separate contract) decrypts
  cleanly in the same session — confirms the TN itself is alive for
  this kernel.
- **Probe scripts:** `scripts/probe-cofhe-encrypt.ts` (verifier
  round-trip — returns `[OK]`).

Contact: <miloshaku@gmail.com> (MuHaven dev lead) — happy to debug
further over a call or shared session.
