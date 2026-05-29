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

import {
  concatHex,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  pad,
  parseAbi,
  parseAbiParameters,
  type Hex,
} from 'viem';

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
 * Wave 5 Slice 2c (auto-reinvest, atomic claim+buy) — Kernel v3.1 mode
 * for `callType=batch (0x01), execType=default`. Leading byte `0x01`
 * (CALL_TYPE.BATCH per `@zerodev/sdk/constants::CALL_TYPE`), the rest
 * zero (default execType + no mode selector/payload). Sibling of
 * `KERNEL_V3_SINGLE_CALL_MODE_DEFAULT`.
 */
export const KERNEL_V3_BATCH_MODE_DEFAULT: Hex =
  `0x01${'00'.repeat(31)}` as Hex;

export interface EncodeKernelExecuteBatchInput {
  /** The ordered inner calls. For reinvest: [claim, buy]. */
  readonly calls: ReadonlyArray<{
    readonly target: `0x${string}`;
    readonly value: bigint;
    readonly callData: `0x${string}`;
  }>;
}

/**
 * Build the `execute(...)` calldata for a BATCH of inner calls in
 * default execType (any inner revert bubbles → the whole batch reverts,
 * which is the atomicity we want for claim+buy: never claim without the
 * buy also succeeding in the same UserOp).
 *
 * UNLIKE the single-call encoding (`abi.encodePacked(target,value,callData)`),
 * the batch `executionCalldata` is the standard ABI encoding of an
 * `Execution[]` array — `abi.encode((address target, uint256 value,
 * bytes callData)[])` — which is exactly what the ZeroDev kernel SDK's
 * `account.encodeCalls([a, b])` produces for callType=batch + what the
 * kernel's batch decoder expects.
 *
 * Same Kernel v3.0/v3.1 version pin as the single-call encoder (see the
 * file-level "Kernel-version pin" JSDoc).
 */
export function encodeKernelExecuteBatch(
  input: EncodeKernelExecuteBatchInput,
): `0x${string}` {
  const executionCalldata = encodeAbiParameters(
    parseAbiParameters('(address target, uint256 value, bytes callData)[]'),
    [
      input.calls.map((c) => ({
        target: c.target,
        value: c.value,
        callData: c.callData,
      })),
    ],
  );
  return encodeFunctionData({
    abi: KERNEL_EXECUTE_ABI,
    functionName: 'execute',
    args: [KERNEL_V3_BATCH_MODE_DEFAULT, executionCalldata],
  });
}

/**
 * 0.2.9 — sibling DECODER for diagnostic purposes. Given the bytes
 * `userOp.callData` carries (i.e. what `encodeKernelExecuteSingleCall`
 * produced), unpack:
 *
 *   - `mode` (32-byte exec-mode word, returned for human inspection)
 *   - the inner CALL's `target`, `value`, and inner `callData`
 *
 * For the single-call default mode we ship today, the
 * executionCalldata is `abi.encodePacked(target20, value32, callData)`
 * — exactly what `encodeKernelExecuteSingleCall` writes.
 *
 * Returns `null` when the input is malformed or when the mode is NOT
 * single-call default — surfaces nicely as an absent diagnostic field
 * instead of a thrown error inside the Path D fallback echo path.
 */
export interface DecodedKernelExecuteSingleCall {
  readonly mode: Hex;
  readonly target: `0x${string}`;
  readonly value: bigint;
  readonly innerCallData: `0x${string}`;
}

export function decodeKernelExecuteSingleCall(
  data: `0x${string}`,
): DecodedKernelExecuteSingleCall | null {
  // The outer encoding is `execute(bytes32 mode, bytes executionCalldata)`
  // — standard ABI. Selector + (32 bytes mode + 32-byte offset to bytes
  // + bytes-length + padded bytes). Reuse the same KERNEL_EXECUTE_ABI
  // the encoder uses; viem's `decodeFunctionData` does the heavy lift.
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: KERNEL_EXECUTE_ABI, data });
  } catch {
    return null;
  }
  const [mode, executionCalldata] = decoded.args as [Hex, Hex];
  // Only the all-zero single-call default mode has the packed inner
  // shape we know. Other modes (batch, delegate, try-mode) need
  // different parsers — return null so the diagnostic emits a clear
  // "mode not decodable" gap instead of garbage.
  if (mode !== KERNEL_V3_SINGLE_CALL_MODE_DEFAULT) {
    return null;
  }
  // executionCalldata layout (single-call default): 20 bytes target,
  // 32 bytes value, then the inner callData. Minimum legitimate
  // length is 20+32 = 52 bytes (= `0x` + 104 hex chars) when the
  // inner callData is empty.
  const ec = executionCalldata.slice(2); // drop `0x`
  if (ec.length < 20 * 2 + 32 * 2) {
    return null;
  }
  const target = (`0x${ec.slice(0, 40)}`) as `0x${string}`;
  const value = BigInt(`0x${ec.slice(40, 40 + 64)}`);
  const innerCallData = (`0x${ec.slice(40 + 64)}`) as `0x${string}`;
  return { mode, target, value, innerCallData };
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
 * validator); `0x01` = ENABLE (carries the validator-install payload
 * inside the signature; on-chain kernel splits + installs the validator
 * atomically with the inner call). From `@zerodev/sdk/constants.ts`'s
 * `VALIDATOR_MODE` enum.
 *
 * Wave 5 Option D Commit 3 enabled the ENABLE branch — the MCP server
 * composes the first Path D UserOp on a freshly-minted Scoped session
 * in ENABLE mode so the PermissionValidator install + the buy land in
 * a single tx. Subsequent buys use DEFAULT.
 */
const VALIDATOR_MODE_DEFAULT: Hex = '0x00' as Hex;
const VALIDATOR_MODE_ENABLE: Hex = '0x01' as Hex;

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
export type ValidatorMode = 'default' | 'enable';

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
  /**
   * Wave 5 Option D Commit 3 — `'enable'` flips byte 0 of the composite
   * from `0x00` (DEFAULT) to `0x01` (ENABLE). Used for the FIRST UserOp
   * after a Scoped session is minted: the validator install payload is
   * wrapped into the signature via `wrapEnableModeSignature`, the
   * kernel splits it on-chain, installs the PermissionValidator, then
   * executes the inner call atomically. Subsequent UserOps use
   * `'default'`. Bytes 1..23 are identical between the two modes — only
   * the leading byte changes. (Source: `@zerodev/sdk` `_cjs/accounts/
   * utils/toKernelPluginManager.js` — the mode byte is the leading
   * byte of `getEncodedNonce`.)
   */
  readonly mode?: ValidatorMode;
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
  const modeByte = args.mode === 'enable' ? VALIDATOR_MODE_ENABLE : VALIDATOR_MODE_DEFAULT;
  const composite = pad(
    concatHex([
      modeByte,
      VALIDATOR_TYPE_PERMISSION,
      paddedPermissionId,
      customKeyHex,
    ]),
    { size: 24 },
  );
  return BigInt(composite);
}

// ── Wave 5 Option D Commit 3 — MODE.ENABLE signature wrapper ────────

/**
 * Selector byte for the inner call type. `0xFF` = DELEGATE_CALL per
 * `@zerodev/sdk/constants.ts::CALL_TYPE`. This is what the canonical
 * `getEncodedPluginsData` writes alongside the `selectorInitData` /
 * `hookInitData` ABI pair (per the SDK's TODO comment in source).
 *
 * The CALL_TYPE byte is encoded as an ABI `bytes` (variable-length)
 * — NOT a single byte — to match `parseAbiParameters('bytes
 * selectorInitData, bytes hookInitData')`. The viem `encodeAbiParameters`
 * passes `'0xff'` through unchanged (single-byte bytes value) once the
 * canonical SDK has put it in that ABI envelope.
 */
const CALL_TYPE_DELEGATE_CALL: Hex = '0xFF' as Hex;

/**
 * Wave 5 Option D Commit 3 — wrap the ECDSA UserOp signature with the
 * PermissionValidator's enable-mode envelope.
 *
 * **BYTE-EXACT mirror of `@zerodev/sdk` `accounts/kernel/utils/plugins/
 * ep0_7/getEncodedPluginsData.ts`** (verified against the deployed source
 * in `frontend/node_modules/@zerodev/sdk/accounts/kernel/utils/plugins/
 * ep0_7/getEncodedPluginsData.ts`). The layout is:
 *
 *   concat([
 *     hookAddress20bytes,                           // raw 20 bytes
 *     abi.encode(
 *       bytes validatorData,                       // = enableData
 *       bytes hookData,                            // = hook?.getEnableData() ?? '0x'
 *       bytes selectorData,                        // concat below
 *       bytes enableSig,                           // = WebAuthn envelope
 *       bytes userOpSig                            // = our wrapped ECDSA
 *     )
 *   ])
 *
 *   selectorData = concat([
 *     action.selector,                              // 4 bytes
 *     action.address,                               // 20 bytes
 *     action.hook?.address ?? zeroAddress,          // 20 bytes
 *     abi.encode(
 *       bytes selectorInitData,                    // = '0xFF' (CALL_TYPE.DELEGATE_CALL)
 *       bytes hookInitData                         // = '0x0000'
 *     )
 *   ])
 *
 * **Why a hand-reimplementation here** instead of `import { getEncoded-
 * PluginsData } from '@zerodev/sdk'`: the SDK pulls in viem-account-
 * abstraction internals + signers + permission-validator surface, all of
 * which are out-of-scope for the MCP server (no signing keys, no wallet
 * UI). The byte-equality regression test in `kernel-encoder.test.ts`
 * imports the canonical SDK as a devDep and asserts identical output for
 * 5 fixtures — that's the anti-drift gate per
 * `[[feedback-ai-engineer-catches-zerodev-shape-drift]]`.
 *
 * **`userOpSig` is the FULL wrapped session-key signature** (66 bytes:
 * `0xff` PermissionValidator sentinel + 65 bytes ECDSA). Pass the output
 * of `buildKernelSessionKeySignature({ecdsaSignature: brokerSig})` here,
 * NOT the raw 65-byte ECDSA. The on-chain validator parses MODE.ENABLE
 * by stripping the envelope first then running the same validation path
 * a MODE.DEFAULT signature would have run.
 */
export interface WrapEnableModeSignatureInput {
  /**
   * `enableData` from `permissionValidator.getEnableData(accountAddress)`
   * — captured by the frontend at mint time and re-surfaced via the C2
   * install-material subroute. Variable size: real-world Wave 5 policy
   * sets produce ~30KB hex.
   */
  readonly enableData: `0x${string}`;
  /**
   * `enableSig` from the user's passkey signing the
   * `getPluginsEnableTypedData(...)` payload. ZeroDev passkey-validator
   * emits a WebAuthn-shaped envelope (256-1024 bytes hex). NOT a bare
   * 65-byte ECDSA sig.
   */
  readonly enableSig: `0x${string}`;
  /**
   * The wrapped 66-byte session-key signature (`0xff` sentinel +
   * 65-byte ECDSA). Use `buildKernelSessionKeySignature(...)` to produce
   * this from the broker's ECDSA output BEFORE passing it here.
   */
  readonly userOpSignature: `0x${string}`;
  /**
   * Optional executor hook. `undefined` for our case (no hook); the
   * encoder emits the zero address for both the leading bytes20 and the
   * inside `action.hook?.address` slot.
   */
  readonly hookAddress?: `0x${string}`;
  /**
   * `hook?.getEnableData()`. `'0x'` when no hook. Carried as a separate
   * field so a future hook-using caller can plug in without rewriting
   * the wrapper.
   */
  readonly hookData?: `0x${string}`;
  /**
   * Inner action selector + address. For the Path D UserOp this is the
   * kernel.execute selector (`0xe9ae5c53`) + the ZeroDev built-in-execute
   * action address, which is the ZERO ADDRESS — NOT the kernel address.
   * The enable digest the on-chain kernel recomputes embeds `action.address`
   * in its `selectorData`; it MUST byte-match what the frontend signed
   * (`zerodev.provider.ts` → `{ selector: getActionSelector('0.7'),
   * address: zeroAddress }`). Passing the kernel address here was the C3
   * first-cut bug that reverted `EnableNotApproved()` (0xc48cf8ee).
   */
  readonly action: {
    readonly selector: `0x${string}`;
    readonly address: `0x${string}`;
    /** Inner action's optional hook. Mirrors `Action.hook?.address` on
     *  the SDK side. Undefined for our case. */
    readonly hookAddress?: `0x${string}`;
  };
}

const ZERO_ADDRESS_HEX: `0x${string}` = '0x0000000000000000000000000000000000000000';

export function wrapEnableModeSignature(input: WrapEnableModeSignatureInput): `0x${string}` {
  // selectorData: the inner-action descriptor the on-chain kernel uses
  // to bind the install to the call it executes atomically. 4 + 20 + 20
  // bytes of raw concatenation, then a 2-tuple `(bytes selectorInitData,
  // bytes hookInitData)` ABI-encoded tail.
  const selectorData = concatHex([
    input.action.selector,
    input.action.address,
    input.action.hookAddress ?? ZERO_ADDRESS_HEX,
    encodeAbiParameters(
      parseAbiParameters('bytes selectorInitData, bytes hookInitData'),
      [CALL_TYPE_DELEGATE_CALL, '0x0000'],
    ),
  ]);

  // The 5-field outer abi.encode is what the validator's MODE.ENABLE
  // decoder unpacks. The leading 20 bytes (hook address) live OUTSIDE
  // this ABI envelope per the source.
  const abiEncoded = encodeAbiParameters(
    parseAbiParameters(
      'bytes validatorData, bytes hookData, bytes selectorData, bytes enableSig, bytes userOpSig',
    ),
    [
      input.enableData,
      input.hookData ?? '0x',
      selectorData,
      input.enableSig,
      input.userOpSignature,
    ],
  );

  return concatHex([input.hookAddress ?? ZERO_ADDRESS_HEX, abiEncoded]);
}

/**
 * Wave 5 Option D Commit 3 — Kernel v3.1 `currentNonce()` ABI used by
 * the MCP server's broker pre-check (read on-chain validator nonce →
 * compare to mirror's `validatorNonce` → fallback `enable_sig_stale` on
 * mismatch). Source:
 * `@zerodev/sdk/accounts/kernel/abi/kernel_v_3_1/KernelAccountAbi.ts:44-50`.
 * Returns `uint32`.
 */
export const KERNEL_V3_CURRENT_NONCE_ABI = parseAbi([
  'function currentNonce() view returns (uint32)',
]);

/**
 * Wave 5 Option D Commit 3 (smoke fix) — kernel V3.1 `SelectorSet` event
 * ABI. This is the ACTUAL on-chain signal of an enable-mode permission
 * install — the deployed kernel does NOT emit `PermissionInstalled` for
 * that path (verified against the first `path:'D'` receipt; see memory
 * `feedback_kernel_emits_selectorset_not_permissioninstalled`). The MCP
 * post-receipt notify locates this log's index to forward to the broker
 * callback; the backend indexer + callback route decode it for the
 * authoritative `enable_status` flip.
 *
 * Layout: `SelectorSet(bytes4 selector, bytes21 vId, bool allowed)` — all
 * NON-INDEXED. `vId[0]=0x02` (PERMISSION type); `vId[1..5)` = permissionId.
 */
export const KERNEL_V3_SELECTOR_SET_ABI = parseAbi([
  'event SelectorSet(bytes4 selector, bytes21 vId, bool allowed)',
]);
