/**
 * Wave 5 Slice 2c — the shared reinvest-execution core.
 *
 * `buildAndSubmitReinvestBatch` composes ONE atomic `executeBatch` UserOp
 * that claims a matured epoch and buys more of the same RWA, signs it via
 * the broker, and submits it to the bundler. It is a FOCUSED mirror of
 * `tools/handlers.ts::attemptPathD` — NOT a refactor of it — pinned to the
 * v1 subset:
 *
 *   • MODE.DEFAULT only. The runner refuses to compose a MODE.ENABLE
 *     install (it would need the user's passkey install material + the
 *     enable-envelope wrap). It skips the cycle when the mirror's
 *     `enableStatus !== 'enabled'` — the user's first MANUAL buy/sell/claim
 *     (via the dashboard or the MCP) installs the validator; only then does
 *     the headless runner act.
 *   • Atomic batch `[claimYield, purchase]`. Default execType → any inner
 *     revert bubbles and the WHOLE batch reverts, so a claim never lands
 *     without the buy also succeeding (the operator's locked Q5 choice).
 *   • Amount-blind. The buy leg is a CLEARTEXT reinvest budget (≤ the
 *     per-op cap), NOT the exact claimed proceeds — the claimed amount
 *     stays encrypted. Slice 3's `purchaseEncrypted` would make it exact.
 *
 * Separation of duties (Option D): this runs in the egress-capable but
 * KEYLESS runner. It asks the broker (which holds the session key but has
 * no bundler egress) to SIGN the userOpHash via `sign_userop`; neither half
 * alone can move funds.
 */

import { encodeFunctionData } from 'viem';
import { getUserOperationHash } from 'viem/account-abstraction';
import { BackendClient, BackendError } from '../clients/backend-client.js';
import {
  BrokerClient,
  BrokerClientError,
} from '../clients/broker-client.js';
import { BundlerClient, BundlerClientError } from '../clients/bundler-client.js';
import {
  buildKernelSessionKeySignature,
  composeKernelV3NonceKey,
  encodeKernelExecuteBatch,
} from '../clients/kernel-encoder.js';
import {
  PLACEHOLDER_SIGNATURE,
  SUBSCRIPTION_PURCHASE_ABI,
  SUBSCRIPTION_PURCHASE_SELECTOR,
  YIELD_SNAPSHOT_CLAIM_ABI,
  YIELD_SNAPSHOT_CLAIM_SELECTOR,
} from '../clients/path-d-encoding.js';
// WS-A (0.6.1) — the shared mirror transform lets the keyless runner
// self-heal a missing policy snapshot from the backend mirror (the same
// recovery `attemptPathD` does), without importing the tool surface.
import {
  type ScopedSessionMirrorResponse,
  MirrorDtoMalformedError,
  mirrorDtoToPolicySnapshot,
} from '../clients/scoped-session-mirror.js';

const ADDRESS_HEX = /^0x[0-9a-fA-F]{40}$/;

export interface ReinvestBatchDeps {
  readonly broker: BrokerClient;
  readonly bundler: BundlerClient;
  readonly backend: BackendClient;
  readonly entryPointAddress: `0x${string}`;
  readonly chainId: number;
  /** `MuHavenSubscription.purchase` target — the buy-leg kernel.execute
   *  target. Required (Path D buy is impossible without it). */
  readonly subscriptionAddress: `0x${string}`;
}

export interface ReinvestBatchInput {
  /** Claimable epoch id (≥ 1). The claim leg's arg0. */
  readonly epochId: bigint;
  readonly tokenAddress: `0x${string}`;
  readonly tokenSymbol: string;
  /** Per-token YieldSnapshot proxy — the claim-leg kernel.execute target. */
  readonly snapshotAddress: `0x${string}`;
  /**
   * The cleartext share count the buy budget converts to (budgetUsd6 / NAV,
   * computed by the daemon). The core re-clamps to the snapshot's per-op
   * cap defensively.
   */
  readonly requestedShares: bigint;
  /** Cleartext per-cycle reinvest budget (6-dp mhUSDC) — audit only. */
  readonly budgetUsd6: bigint;
  /** Correlation id stamped by the daemon for this (token, epoch) attempt. */
  readonly reinvestCycleId: string;
}

export type ReinvestSkipReason =
  | 'broker_not_ready'
  | 'broker_error'
  | 'no_active_snapshot'
  | 'signer_mismatch'
  | 'selector_not_in_snapshot'
  | 'selector_uncapped'
  | 'target_not_in_snapshot'
  | 'no_permission_id'
  | 'no_account_address'
  | 'session_revoked'
  | 'validator_not_enabled'
  | 'shares_zero_after_clamp'
  | 'backend_rejected'
  | 'backend_error'
  | 'bundler_setup_failed'
  | 'paymaster_rejected'
  | 'bundler_submit_rejected';

export type ReinvestBatchResult =
  /** Submitted + a receipt landed. Record the audit with `txHash`. */
  | {
      readonly kind: 'ok';
      readonly userOpHash: `0x${string}`;
      readonly txHash: `0x${string}`;
      readonly buyShares: bigint;
    }
  /** Submitted but no receipt within the wait budget. The UserOp may still
   *  mine — the daemon records the audit with the userOpHash only + applies
   *  the per-(token,epoch) cooldown (same as `ok`; the default 30-min
   *  cooldown is far longer than the settle window) so it doesn't
   *  double-submit while it settles. */
  | {
      readonly kind: 'submitted_no_receipt';
      readonly userOpHash: `0x${string}`;
      readonly buyShares: bigint;
    }
  /** No UserOp built / submitted — gate not met or config missing. The
   *  daemon logs the reason + retries next cycle. */
  | { readonly kind: 'skip'; readonly reason: ReinvestSkipReason; readonly message: string };

/** The `skip` variant of `ReinvestBatchResult`, extracted so helpers that can
 *  ONLY skip (never submit) declare a precise return type. Narrow → wide, so a
 *  `ReinvestSkip` is still assignable wherever a `ReinvestBatchResult` is. */
type ReinvestSkip = Extract<ReinvestBatchResult, { kind: 'skip' }>;

function skip(reason: ReinvestSkipReason, message: string): ReinvestSkip {
  return { kind: 'skip', reason, message };
}

interface PolicyStateDto {
  readonly accountAddress?: string;
}

/**
 * WS-A (0.6.1) — self-heal a missing broker policy snapshot from the
 * backend mirror. A freshly-restarted broker holds the session KEY but
 * has no policy SNAPSHOT on disk for the current signer, so
 * `getActiveSessionId()` returns null until a manual Path-D op syncs it.
 * This reproduces the exact recovery `attemptPathD` runs
 * (`handlers.ts::syncSnapshotFromMirror`): fetch the mirror's latest
 * active scoped-session row, validate it's bound to the broker's live
 * signer, install it via IPC, and re-probe.
 *
 * Returns the now-active sessionId, or a `skip` to bubble straight out of
 * `buildAndSubmitReinvestBatch` (the daemon logs the reason + retries
 * next cycle). The runner uses the SAME JWT the gate used, so the mirror
 * read sees the same session.
 */
async function syncSnapshotFromMirror(
  backend: BackendClient,
  broker: BrokerClient,
  brokerSignerAddress: string,
): Promise<{ readonly kind: 'ok'; readonly sessionId: string } | ReinvestSkip> {
  let mirror: ScopedSessionMirrorResponse;
  try {
    mirror = await backend.get<ScopedSessionMirrorResponse>(
      '/api/v1/agent/policy/scoped-session',
      { surface: 'mcp' },
    );
  } catch (err) {
    if (err instanceof BackendError && typeof err.status === 'number' && err.status < 500) {
      return skip('backend_rejected', `mirror lookup for auto-sync rejected (backend.${err.code})`);
    }
    return skip('backend_error', `mirror lookup for auto-sync failed: ${backendErr(err)}`);
  }
  // Loose `== null` catches both an absent `session` and an explicit null
  // (the backend's `findLatestActive` returns null for revoked/expired) —
  // nothing to sync; the user must mint/enable a scoped session.
  if (!mirror || mirror.session == null) {
    return skip(
      'no_active_snapshot',
      'broker has no active session snapshot and the backend mirror has none to sync — mint + enable a scoped session (with reinvest opt-in) from the dashboard',
    );
  }
  let wire: import('../broker/protocol.js').PolicySnapshotWire;
  try {
    wire = mirrorDtoToPolicySnapshot(mirror.session);
  } catch (err) {
    // MirrorDtoMalformedError carries only a structural message (no
    // attacker-controlled text); other throws are unexpected shape bugs.
    if (err instanceof MirrorDtoMalformedError) {
      return skip('backend_error', `mirror returned a malformed scoped-session row (${err.message})`);
    }
    return skip('backend_error', `mirror transform failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Signer-mismatch pre-check (same as handlers.ts CR M-1): storing a
  // snapshot bound to a different signer than the broker has loaded would
  // land an unreachable row in the keystore. Bounce with a concrete reason.
  if (wire.signerAddress.toLowerCase() !== brokerSignerAddress.toLowerCase()) {
    return skip(
      'signer_mismatch',
      `mirror snapshot bound to ${wire.signerAddress}, broker signs as ${brokerSignerAddress} — re-mint the scoped tier against the broker's current session key`,
    );
  }
  try {
    await broker.storePolicySnapshot(wire);
  } catch (err) {
    return skip('broker_error', `store_policy_snapshot (auto-sync) failed: ${brokerErr(err)}`);
  }
  let activeId: string | null;
  try {
    activeId = (await broker.getActiveSessionId()).sessionId;
  } catch (err) {
    return skip('broker_error', `get_active_session_id re-probe after auto-sync failed: ${brokerErr(err)}`);
  }
  if (!activeId) {
    return skip(
      'no_active_snapshot',
      'broker accepted the auto-synced snapshot but still reports no active session — most likely multiple non-expired snapshots for the same signer (ambiguous); clear stale snapshots via the muhaven-broker CLI',
    );
  }
  return { kind: 'ok', sessionId: activeId };
}

export async function buildAndSubmitReinvestBatch(
  input: ReinvestBatchInput,
  deps: ReinvestBatchDeps,
): Promise<ReinvestBatchResult> {
  const { broker, bundler, backend, entryPointAddress, chainId, subscriptionAddress } = deps;

  // 0. Clear the bundler trace so any diagnostic the daemon logs is scoped
  //    to THIS attempt.
  bundler.drainTrace();

  // 1. Broker reachable + protocol ≥ 0.6.0 (innerCalls) + session key loaded.
  const preflight = await broker.preflight();
  if (!preflight.supported) {
    return skip(
      'broker_not_ready',
      preflight.reason === 'broker_unreachable'
        ? `broker unreachable (${preflight.message})`
        : preflight.reason === 'version_too_old'
          ? `broker speaks ${preflight.daemonVersion}, reinvest batch requires ≥${preflight.requiredVersion} — upgrade @muhaven/mcp + restart the broker`
          : 'broker is in read-only posture (no session key)',
    );
  }

  // 2. Active session id (broker keystore). The runner is STATELESS re:
  //    credentials — it never caches; a fresh value is read every cycle.
  let activeId: string | null;
  try {
    activeId = (await broker.getActiveSessionId()).sessionId;
  } catch (err) {
    return skip('broker_error', `get_active_session_id failed: ${brokerErr(err)}`);
  }
  if (!activeId) {
    // WS-A (0.6.1) self-heal: a freshly-restarted broker has the session
    // KEY but no policy SNAPSHOT for the current signer. Instead of idling
    // until a manual op syncs it, run the SAME mirror-sync `attemptPathD`
    // does — fetch the mirror's active row, validate the signer, install
    // it, re-probe. On any miss, the sync returns the precise skip reason.
    const synced = await syncSnapshotFromMirror(backend, broker, preflight.signerAddress);
    if (synced.kind !== 'ok') return synced;
    activeId = synced.sessionId;
  }

  // 3. Snapshot still readable + bound to the live signer.
  let snapshot: import('../broker/protocol.js').PolicySnapshotWire | null;
  try {
    snapshot = (await broker.getPolicySnapshot(activeId)).snapshot;
  } catch (err) {
    return skip('broker_error', `get_policy_snapshot failed: ${brokerErr(err)}`);
  }
  if (!snapshot) {
    return skip('no_active_snapshot', `snapshot for ${activeId} vanished (GC race) — retry next cycle`);
  }
  if (snapshot.signerAddress.toLowerCase() !== preflight.signerAddress.toLowerCase()) {
    return skip(
      'signer_mismatch',
      `snapshot bound to ${snapshot.signerAddress}, broker signs as ${preflight.signerAddress} — key rotated; re-mint`,
    );
  }

  // 4. Scope: BOTH legs' selectors + targets must be authorized.
  const purchaseCap = snapshot.selectorCaps.find(
    (c) => c.selector.toLowerCase() === SUBSCRIPTION_PURCHASE_SELECTOR,
  );
  const claimCap = snapshot.selectorCaps.find(
    (c) => c.selector.toLowerCase() === YIELD_SNAPSHOT_CLAIM_SELECTOR,
  );
  if (!purchaseCap || !claimCap) {
    return skip(
      'selector_not_in_snapshot',
      'snapshot lacks the purchase and/or claimYield selectorCap — re-sync the tier (a manual buy/claim repopulates it)',
    );
  }
  if (purchaseCap.maxAmount === null) {
    return skip('selector_uncapped', 'purchase selectorCap has no per-op cap — refusing to autonomously buy');
  }
  const maxShares = BigInt(purchaseCap.maxAmount);
  // Clamp the budget-derived share count to the per-op cap (the cap is the
  // hard ceiling; the daemon's budget should sit under it, but a high NAV
  // swing could push it over — buy up to the cap rather than skip).
  const buyShares = input.requestedShares > maxShares ? maxShares : input.requestedShares;
  if (buyShares <= 0n) {
    return skip('shares_zero_after_clamp', 'budget converts to 0 buyable shares at the current NAV/cap');
  }
  const targets = new Set(snapshot.targetContracts.map((t) => t.toLowerCase()));
  if (!targets.has(subscriptionAddress.toLowerCase())) {
    return skip('target_not_in_snapshot', 'subscription target not in the snapshot allowlist');
  }
  if (!targets.has(input.snapshotAddress.toLowerCase())) {
    return skip('target_not_in_snapshot', `YieldSnapshot ${input.snapshotAddress} not in the snapshot allowlist`);
  }

  // 5. permissionId — required to compose the Kernel v3.1 nonce-key
  //    composite (else the bundler reads the SUDO nonce slot → AA24).
  if (!snapshot.permissionId) {
    return skip('no_permission_id', 'snapshot lacks permissionId — re-mint via the dashboard ceremony');
  }
  const permissionId = snapshot.permissionId;

  // 6. Backend: resolve the kernel account + the mirror enable_status.
  let accountAddress: `0x${string}`;
  try {
    const state = (await backend.get('/api/v1/agent/policy/state', { surface: 'mcp' })) as PolicyStateDto;
    if (!state.accountAddress || !ADDRESS_HEX.test(state.accountAddress)) {
      return skip('no_account_address', 'backend /agent/policy/state returned no accountAddress — re-login the broker');
    }
    accountAddress = state.accountAddress.toLowerCase() as `0x${string}`;
  } catch (err) {
    return skip('backend_error', `/agent/policy/state lookup failed: ${backendErr(err)}`);
  }

  // 6a. REVOKE KILL-SWITCH + enable-status gate (mirror is authoritative).
  //     This mirror read is DELIBERATELY a fresh fetch — NOT reused from the
  //     WS-A step-2 self-heal read. It must run as late as possible before we
  //     sign, so a revoke that lands between step 2 and here still fails closed.
  //     Do NOT "optimize" by threading the step-2 result forward — that would
  //     widen the revoke TOCTOU window (BE-Arch review).
  try {
    const mirror = await backend.get<ScopedSessionMirrorResponse>(
      '/api/v1/agent/policy/scoped-session',
      { surface: 'mcp' },
    );
    if (!mirror?.session) {
      // Session revoked/expired on the dashboard since the broker last
      // synced — purge the broker's now-stale key-backed snapshot.
      try {
        await broker.clearPolicySnapshot(activeId);
      } catch {
        /* best-effort; the 8h TTL bounds it regardless */
      }
      return skip('session_revoked', 'Scoped session was revoked/expired — purged broker snapshot');
    }
    if (mirror.session.enableStatus !== 'enabled') {
      return skip(
        'validator_not_enabled',
        `enableStatus=${mirror.session.enableStatus ?? 'null'} — the v1 runner only acts on an ENABLED validator; ` +
          'your first manual buy/sell/claim installs it (MODE.ENABLE)',
      );
    }
  } catch (err) {
    return skip('backend_error', `/agent/policy/scoped-session lookup failed: ${backendErr(err)}`);
  }

  // 7. Backend-mediated FHE. The runner never imports @cofhe/sdk.
  //    claim leg → mint a throwaway eph (FHE.allow decrypt-grant target).
  //    buy leg   → encrypt the cleartext budget shares into InEuint128.
  //    Both routes share the revoke kill-switch session gate.
  let ephClaim: `0x${string}`;
  let encShares: { ctHash: `0x${string}`; securityZone: number; utype: number; signature: `0x${string}` };
  let ephBuy: `0x${string}`;
  try {
    const mint = (await backend.post('/api/v1/agent/path-d/mint-ephemeral', {
      tokenAddress: input.tokenAddress,
    })) as { ephemeralEOA?: string };
    if (typeof mint.ephemeralEOA !== 'string' || !ADDRESS_HEX.test(mint.ephemeralEOA)) {
      return skip('backend_error', 'mint-ephemeral returned a malformed ephemeralEOA');
    }
    ephClaim = mint.ephemeralEOA.toLowerCase() as `0x${string}`;

    const enc = (await backend.post('/api/v1/agent/path-d/encrypt-shares', {
      tokenAddress: input.tokenAddress,
      sharesAmount: buyShares.toString(),
    })) as {
      encShares?: { ctHash?: string; securityZone?: number; utype?: number; signature?: string };
      ephemeralEOA?: string;
    };
    if (
      !enc.encShares ||
      typeof enc.encShares.ctHash !== 'string' ||
      typeof enc.encShares.securityZone !== 'number' ||
      typeof enc.encShares.utype !== 'number' ||
      typeof enc.encShares.signature !== 'string' ||
      typeof enc.ephemeralEOA !== 'string'
    ) {
      return skip('backend_error', 'encrypt-shares returned a malformed payload');
    }
    encShares = {
      ctHash: enc.encShares.ctHash as `0x${string}`,
      securityZone: enc.encShares.securityZone,
      utype: enc.encShares.utype,
      signature: enc.encShares.signature as `0x${string}`,
    };
    ephBuy = enc.ephemeralEOA as `0x${string}`;
  } catch (err) {
    if (err instanceof BackendError && typeof err.status === 'number' && err.status < 500) {
      // 4xx — user-fixable (token delisted, session revoked between gates).
      return skip('backend_rejected', `backend rejected an FHE step (backend.${err.code})`);
    }
    return skip('backend_error', `backend FHE step failed: ${backendErr(err)}`);
  }

  // 8. Encode the two inner calls.
  const claimCallData = encodeFunctionData({
    abi: YIELD_SNAPSHOT_CLAIM_ABI,
    functionName: 'claimYield',
    args: [input.epochId, ephClaim],
  } as Parameters<typeof encodeFunctionData>[0]) as `0x${string}`;
  const buyCallData = encodeFunctionData({
    abi: SUBSCRIPTION_PURCHASE_ABI,
    functionName: 'purchase',
    args: [
      input.tokenAddress,
      {
        ctHash: BigInt(encShares.ctHash),
        securityZone: encShares.securityZone,
        utype: encShares.utype,
        signature: encShares.signature,
      },
      buyShares,
      ephBuy,
    ],
  } as Parameters<typeof encodeFunctionData>[0]) as `0x${string}`;

  // Ordered [claim, buy] — claim first so its proceeds are available to the
  // buy in the same UserOp. Both `value: 0` (fhERC-20 / mhUSDC flows).
  const calls = [
    { target: input.snapshotAddress, value: 0n, callData: claimCallData },
    { target: subscriptionAddress, value: 0n, callData: buyCallData },
  ] as const;

  // 9. Wrap in kernel.execute (batch, default execType → inner revert bubbles).
  const kernelCallData = encodeKernelExecuteBatch({ calls: calls.map((c) => ({ ...c })) });

  // 10. Bundler bootstrap (MODE.DEFAULT nonce-key composite + fee market).
  let nonce: bigint;
  let feeData: { maxFeePerGas: `0x${string}`; maxPriorityFeePerGas: `0x${string}` };
  try {
    const nonceKey = composeKernelV3NonceKey({ permissionId, mode: 'default' });
    nonce = await bundler.getNonce(accountAddress, entryPointAddress, nonceKey);
    feeData = await bundler.getFeeData();
  } catch (err) {
    return skip('bundler_setup_failed', `bundler bootstrap failed: ${bundlerErr(err)}`);
  }

  // 11. Sponsor (placeholder signature; no enable-envelope wrap in MODE.DEFAULT).
  let sponsored: Awaited<ReturnType<typeof bundler.sponsorUserOp>>;
  try {
    sponsored = await bundler.sponsorUserOp(
      {
        sender: accountAddress,
        nonce: `0x${nonce.toString(16)}` as `0x${string}`,
        callData: kernelCallData,
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
        signature: PLACEHOLDER_SIGNATURE,
      },
      entryPointAddress,
    );
  } catch (err) {
    return skip('paymaster_rejected', `zd_sponsorUserOperation rejected: ${bundlerErr(err)}`);
  }

  // 12. Compose the final UserOp + hash (viem strips the signature pre-hash).
  const userOpHash = getUserOperationHash({
    userOperation: {
      sender: accountAddress,
      nonce,
      factory: undefined,
      factoryData: undefined,
      callData: kernelCallData,
      callGasLimit: BigInt(sponsored.callGasLimit),
      verificationGasLimit: BigInt(sponsored.verificationGasLimit),
      preVerificationGas: BigInt(sponsored.preVerificationGas),
      maxFeePerGas: BigInt(feeData.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(feeData.maxPriorityFeePerGas),
      paymaster: sponsored.paymaster,
      paymasterVerificationGasLimit: BigInt(sponsored.paymasterVerificationGasLimit),
      paymasterPostOpGasLimit: BigInt(sponsored.paymasterPostOpGasLimit),
      paymasterData: sponsored.paymasterData,
      signature: PLACEHOLDER_SIGNATURE,
    } as Parameters<typeof getUserOperationHash>[0]['userOperation'],
    entryPointAddress,
    entryPointVersion: '0.7',
    chainId,
  });

  // 13. Broker policy-gated sign. innerCalls = [claim, buy] → the daemon
  //     checkPolicy's EVERY leg (per-op cap on the buy; selector+target on
  //     the claim). innerCall = calls[0] for pre-0.6.0 back-compat.
  let brokerSig: `0x${string}`;
  try {
    const signed = await broker.signUserOp({
      sessionId: activeId,
      userOpHash,
      innerCall: { target: calls[0].target, callData: calls[0].callData },
      innerCalls: calls.map((c) => ({ target: c.target, callData: c.callData })),
      intent: {
        tool: 'muhaven.position.claim',
        summary: `reinvest: claim epoch ${input.epochId.toString()} + buy ${buyShares.toString()} ${input.tokenSymbol} [cycle ${input.reinvestCycleId}]`,
      },
    });
    brokerSig = signed.signature;
  } catch (err) {
    if (err instanceof BrokerClientError && err.brokerCode === 'max_spend_exceeded') {
      return skip('selector_uncapped', 'broker rejected sign_userop: max_spend_exceeded on the buy leg');
    }
    return skip('broker_error', `sign_userop failed: ${brokerErr(err)}`);
  }

  // 14. Replace placeholder with the wrapped session-key signature.
  const finalSignature = buildKernelSessionKeySignature({ ecdsaSignature: brokerSig });
  const wire = {
    sender: accountAddress,
    nonce: `0x${nonce.toString(16)}` as `0x${string}`,
    callData: kernelCallData,
    callGasLimit: sponsored.callGasLimit,
    verificationGasLimit: sponsored.verificationGasLimit,
    preVerificationGas: sponsored.preVerificationGas,
    maxFeePerGas: feeData.maxFeePerGas,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
    paymaster: sponsored.paymaster,
    paymasterVerificationGasLimit: sponsored.paymasterVerificationGasLimit,
    paymasterPostOpGasLimit: sponsored.paymasterPostOpGasLimit,
    paymasterData: sponsored.paymasterData,
    signature: finalSignature,
  };

  // 15. Submit + sanity-check the returned hash.
  let submittedHash: `0x${string}`;
  try {
    submittedHash = await bundler.sendUserOp(wire, entryPointAddress);
  } catch (err) {
    return skip('bundler_submit_rejected', `eth_sendUserOperation rejected: ${bundlerErr(err)}`);
  }
  if (submittedHash.toLowerCase() !== userOpHash.toLowerCase()) {
    // The bundler ACCEPTED the op (sendUserOp resolved) but echoed a hash
    // ≠ what we signed. Our signature is over `userOpHash`, so the bundler's
    // op can't pass on-chain validation (AA24) and won't mine — but it IS in
    // the mempool. Treat this as a SUBMIT (not a skip) so the runner sets the
    // cooldown + records the audit, rather than re-submitting a fresh op next
    // cycle into a possible double-fill. (`attemptPathD` returns the hash to
    // an LLM to verify; the headless runner has no verifier, so it must fail
    // CLOSED here — wait out the cooldown.)
    return { kind: 'submitted_no_receipt', userOpHash, buyShares };
  }

  // 16. Wait for receipt. From here the UserOp is in the mempool — every
  //     return is a SUBMIT (ok / submitted_no_receipt), never a skip, so the
  //     daemon records the audit + applies a cooldown to avoid double-fill.
  try {
    const receipt = await bundler.waitForReceipt(userOpHash, { timeoutMs: 12_000 });
    return {
      kind: 'ok',
      userOpHash,
      txHash: receipt.receipt.transactionHash as `0x${string}`,
      buyShares,
    };
  } catch {
    try {
      const late = await bundler.getReceipt(userOpHash);
      if (late) {
        return {
          kind: 'ok',
          userOpHash,
          txHash: late.receipt.transactionHash as `0x${string}`,
          buyShares,
        };
      }
    } catch {
      /* fall through */
    }
    return { kind: 'submitted_no_receipt', userOpHash, buyShares };
  }
}

function brokerErr(err: unknown): string {
  if (err instanceof BrokerClientError) return `${err.code}${err.brokerCode ? `/${err.brokerCode}` : ''}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
function backendErr(err: unknown): string {
  if (err instanceof BackendError) return `${err.code}`;
  return err instanceof Error ? err.message : String(err);
}
function bundlerErr(err: unknown): string {
  if (err instanceof BundlerClientError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
