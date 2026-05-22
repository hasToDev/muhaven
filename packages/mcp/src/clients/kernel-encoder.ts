/**
 * Wave 5 Path D Slice 1 (Commit 3.5) — minimal Kernel v3.1 single-call
 * `execute(bytes32 mode, bytes executionCalldata)` encoder.
 *
 * The frontend's `client.account.encodeCalls([call])` produces the same
 * bytes via the ZeroDev kernel SDK. We re-implement the single-call
 * subset here MCP-server-side so the @zerodev/sdk + @zerodev/permissions
 * dependency tree doesn't bleed into the MCP package — those packages
 * pull in viem-account-abstraction internals + signers + the full
 * permission-validator surface, all of which are inappropriate for the
 * MCP server (no signing keys, no wallet UI).
 *
 * ## Kernel v3 execution-mode encoding
 *
 * The `mode` arg is a packed 32-byte structure:
 *
 *   bytes 0       callType   — 0x00=single, 0x01=batch, 0xff=delegate
 *   bytes 1       execType   — 0x00=default (revert on inner revert),
 *                              0x01=try
 *   bytes 2..5    modeSelector — 4-byte selector for the mode handler
 *                                (0x00000000 for the standard handlers)
 *   bytes 6..31   modePayload  — packed bytes for the mode (zero-pad
 *                                for single + default)
 *
 * For a single CALL in DEFAULT exec mode, every byte is zero —
 * `SINGLE_CALL_MODE_DEFAULT` below is 32 zero bytes.
 *
 * ## executionCalldata encoding for callType=single
 *
 * `abi.encodePacked(target, value, callData)` — NOT `abi.encode`. This
 * is load-bearing: a regular abi.encode would emit length-prefixed
 * bytes and zero-padded address/value, which the kernel's single-call
 * decoder would interpret as garbage.
 *
 * ## Kernel-version pin
 *
 * This encoding is specific to Kernel v3.0 / v3.1 (same execution-mode
 * layout). A future Kernel v4 may re-pack the mode word OR change the
 * single-call inner shape. If ZeroDev rotates the kernel version of the
 * user's smart account, Path D will silently revert AA23 on the next
 * autonomous buy until this encoder is updated.
 *
 * Mitigation: PATH_D_PLAN.md "Out of scope" lists this pin as a known
 * limit. Slice 4's canonical userOpHash reconstruction (RD-5) would
 * surface a version drift earlier by re-hashing on the broker side.
 */

import { concatHex, encodeFunctionData, encodePacked, pad, parseAbi, type Hex } from 'viem';

export const KERNEL_EXECUTE_ABI = parseAbi([
  'function execute(bytes32 mode, bytes calldata executionCalldata)',
]);

/**
 * Kernel v3.1 mode for `callType=single, execType=default` — all
 * zero bytes. Pinned as a constant so a future addition (e.g. try-mode
 * for autonomous-buys that should tolerate inner reverts) can declare a
 * sibling constant rather than fan-out into a struct.
 */
export const KERNEL_V3_SINGLE_CALL_MODE_DEFAULT: Hex =
  `0x${'00'.repeat(32)}` as Hex;

export interface EncodeKernelExecuteSingleCallInput {
  /** Target contract the kernel will CALL. */
  readonly target: `0x${string}`;
  /** Native-value wei. Almost always 0n for ERC-20 / fhERC-20 flows. */
  readonly value: bigint;
  /** Inner ABI-encoded calldata (selector + args). */
  readonly callData: `0x${string}`;
}

/**
 * Build the `execute(...)` calldata the kernel UserOp's `callData`
 * field carries. Single CALL, default execType (inner revert bubbles).
 */
export function encodeKernelExecuteSingleCall(
  input: EncodeKernelExecuteSingleCallInput,
): `0x${string}` {
  const executionCalldata = encodePacked(
    ['address', 'uint256', 'bytes'],
    [input.target, input.value, input.callData],
  );
  return encodeFunctionData({
    abi: KERNEL_EXECUTE_ABI,
    functionName: 'execute',
    args: [KERNEL_V3_SINGLE_CALL_MODE_DEFAULT, executionCalldata],
  });
}

/**
 * Wave 5 Path D Slice 1 (Commit 3.5) — Kernel v3.1 PermissionValidator
 * UserOp signature builder.
 *
 * **Verified against the deployed `@zerodev/permissions`**
 * PermissionValidator (`frontend/node_modules/@zerodev/permissions/
 * toPermissionValidator.ts:104-119`). The on-the-wire signature shape
 * for any UserOp routed through an installed permission validator is:
 *
 *   byte 0       — `0xff` (PermissionValidator's "use root permission"
 *                  sentinel; the validator decodes this first to
 *                  disambiguate from enable mode + secondary
 *                  validators)
 *   bytes 1..65  — ECDSA(r || s || v) signature
 *
 * = 66 bytes total = `0x` + 132 hex chars.
 *
 * **The validator address is NOT in the signature.** It is encoded
 * into the nonce key composite instead — see `composeKernelV3NonceKey`
 * below.
 *
 * **The ECDSA signature MUST be over the EIP-191 personal-sign envelope
 * of the userOpHash**, NOT the raw userOpHash. The broker daemon does
 * this via `signer.signRawMessage(...)` in
 * `packages/mcp/src/broker/signer.ts::ViemSigner.signRawMessage`. The
 * on-chain `ecrecover` validates against the same envelope.
 *
 * The PRE-enable case (first-ever session-key UserOp on a kernel where
 * the validator hasn't been baked) carries a different `enableSig`
 * payload and is OUT OF SCOPE for Commit 3.5. Slice 1 acceptance
 * assumes the OPENCLAW stage kernel has exercised its session-key
 * validator at least once via the dashboard (per Q1 walkthrough).
 *
 * Defensive shape check ensures a bug elsewhere can't slip a wrong-
 * length signature into the bundler — easier to debug as a thrown
 * Error here than as an opaque `AA24 InvalidSigner` from the bundler.
 */
export interface BuildKernelSessionKeySignatureInput {
  /**
   * 65-byte EIP-191 ECDSA signature returned by `broker.signUserOp(...)`.
   * Must be `0x` + 130 hex chars (r=32, s=32, v=1 → 65 bytes packed).
   */
  readonly ecdsaSignature: `0x${string}`;
}

const ECDSA_SIG_HEX_RE = /^0x[0-9a-fA-F]{130}$/;

/**
 * PermissionValidator "use root permission" sentinel prefix. From
 * `@zerodev/permissions/toPermissionValidator.ts:118`. The on-chain
 * validator decodes this byte first; substituting `0x00` (sudo) or
 * `0x01` (secondary) would route to a different validator and yield
 * `AA24 InvalidSigner`.
 */
const PERMISSION_USE_PREFIX: Hex = '0xff' as Hex;

export function buildKernelSessionKeySignature(
  input: BuildKernelSessionKeySignatureInput,
): `0x${string}` {
  if (!ECDSA_SIG_HEX_RE.test(input.ecdsaSignature)) {
    throw new Error(
      `buildKernelSessionKeySignature: ecdsaSignature must be a 0x-prefixed 65-byte hex (got ${input.ecdsaSignature.length} chars)`,
    );
  }
  // 1 byte prefix + 65 bytes ECDSA = 66 bytes = 132 hex chars.
  return concatHex([PERMISSION_USE_PREFIX, input.ecdsaSignature]);
}

// ── Wave 5 Path D Slice 1 Commit 3.5 — Kernel v3.1 nonce key composer ──

/**
 * Kernel v3.1 validator mode byte. `0x00` = DEFAULT (run the installed
 * validator); `0x01` = ENABLE (validator carries enable-sig payload —
 * NOT supported by this commit). From `@zerodev/sdk/constants.ts`'s
 * `VALIDATOR_MODE` enum.
 */
const VALIDATOR_MODE_DEFAULT: Hex = '0x00' as Hex;

/**
 * Kernel v3.1 validator-type byte. `0x02` = PERMISSION (use the
 * PermissionValidator → `@zerodev/permissions`); `0x01` = SECONDARY;
 * `0x00` = SUDO (root passkey). From `@zerodev/sdk/constants.ts`'s
 * `VALIDATOR_TYPE` enum.
 */
const VALIDATOR_TYPE_PERMISSION: Hex = '0x02' as Hex;

const PERMISSION_ID_HEX_RE = /^0x[0-9a-fA-F]{8}$/;

/**
 * Compose the 24-byte nonce key Kernel v3.1's EntryPoint expects when
 * routing a UserOp through an installed PermissionValidator.
 *
 * From `@zerodev/sdk/accounts/utils/toKernelPluginManager.ts:398-419`:
 *
 *   pad(concat([
 *     VALIDATOR_MODE,           // 1 byte (0x00 = DEFAULT)
 *     VALIDATOR_TYPE,           // 1 byte (0x02 = PERMISSION)
 *     pad(permissionId, 20),    // 20 bytes (4-byte permissionId
 *                               // right-padded with zeros)
 *     pad(customKey, 2),        // 2 bytes (0x0000 for non-batched)
 *   ]), size: 24)
 *
 * Returned as a `bigint` so the caller can pass it directly to
 * `entryPoint.getNonce(sender, key)` via `bundler.getNonce(...)`.
 *
 * Without the right composite key, the bundler reads the SUDO-validator
 * nonce slot → routes the UserOp through the wrong validator → `AA24
 * InvalidSigner` on-chain (because the broker's session-key signature
 * doesn't match the passkey-validator's installed pubkey).
 */
export function composeKernelV3NonceKey(args: {
  /**
   * 4-byte permissionId from `@zerodev/permissions::getPermissionId()`.
   * Sourced from the broker's policy snapshot's `permissionId` field
   * (populated by the frontend's Pickup B mint POST per commit
   * `1a28618`; legacy pre-Pickup-B snapshots return Path D fallback
   * `no_permission_id_in_snapshot` and never reach this encoder).
   */
  readonly permissionId: `0x${string}`;
  /** Customary 2-byte key for batched UserOps. Slice 1 always 0n
   *  (defaulted when omitted by the only caller at handlers.ts). */
  readonly customKey?: bigint;
}): bigint {
  if (!PERMISSION_ID_HEX_RE.test(args.permissionId)) {
    throw new Error(
      `composeKernelV3NonceKey: permissionId must be a 0x-prefixed 4-byte hex (got ${args.permissionId.length} chars)`,
    );
  }
  const customKey = args.customKey ?? 0n;
  if (customKey < 0n || customKey > 0xffffn) {
    throw new Error(
      `composeKernelV3NonceKey: customKey must fit in 2 bytes (0..0xffff), got ${customKey}`,
    );
  }
  // The 4-byte permissionId is RIGHT-padded to 20 bytes (matches
  // `pad(getIdentifier(), { size: 20, dir: 'right' })` in the kernel SDK).
  const paddedPermissionId = pad(args.permissionId, { size: 20, dir: 'right' });
  const customKeyHex = pad(`0x${customKey.toString(16)}` as Hex, { size: 2 });
  const composite = pad(
    concatHex([
      VALIDATOR_MODE_DEFAULT,
      VALIDATOR_TYPE_PERMISSION,
      paddedPermissionId,
      customKeyHex,
    ]),
    { size: 24 },
  );
  return BigInt(composite);
}
