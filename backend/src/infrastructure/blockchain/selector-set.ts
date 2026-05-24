/**
 * Wave 5 Option D · Commit 3 (smoke fix) — decode the kernel V3.1
 * `SelectorSet` event into the permission-install signal.
 *
 * **Why SelectorSet, not PermissionInstalled.** The deployed Kernel v3.1
 * does NOT emit `PermissionInstalled(bytes4,uint32)` for an enable-mode
 * permission-validator install — verified against the first real Path D
 * `path:'D'` receipt (Arb Sepolia tx
 * `0x5d8e837333c43e2b9a0593726b9d5ec9aa69a808a3330c64966011b0e70c427a`,
 * 2026-05-24). That tx installed the validator + succeeded but emitted only
 * `ModuleInstalled(typeId 5/6, …)` ×3 + a single `SelectorSet` — no
 * `PermissionInstalled`. The C3 first cut keyed both the chain indexer and
 * the broker-callback route on `PermissionInstalled`, so the mirror row
 * never flipped to `'enabled'` (the watchdog would eventually mark it
 * `'failed'`, breaking every repeat autonomous buy).
 *
 * **The matchable signal.** `SelectorSet(bytes4 selector, bytes21 vId,
 * bool allowed)` (all args non-indexed, data-only):
 *   - `vId[0]` = validation type byte; `0x02` = PERMISSION (skip `0x00`
 *     sudo / `0x01` secondary).
 *   - `vId[1..5)` = the 4-byte permissionId.
 *   - `allowed` = true on bind/enable, false on unbind/uninstall.
 *   - emitter (`log.address`) = the kernel smart account (= the mirror
 *     row's `accountAddress`).
 *
 * See memory `feedback_kernel_emits_selectorset_not_permissioninstalled`.
 */

import { decodeEventLog, parseAbi, type Hex, type Log } from 'viem';

export const SELECTOR_SET_EVENT_ABI = parseAbi([
  'event SelectorSet(bytes4 selector, bytes21 vId, bool allowed)',
]);

/** Leading byte of a PermissionValidator validationId (VALIDATION_TYPE.PERMISSION). */
const VALIDATION_TYPE_PERMISSION = '0x02';

/**
 * Kernel v3.1 `execute(bytes32,bytes)` selector — the action MuHaven's
 * Scoped session always binds (the frontend signs the enable typed-data
 * with `getActionSelector('0.7')` = this selector; the buy routes through
 * `kernel.execute`). We require the SelectorSet's `selector` to match so
 * the install signal is EXACT: a same-kernel, same-permissionId bind to a
 * DIFFERENT selector cannot spuriously flip `enable_status` (SecEng
 * defense-in-depth). If a future Scoped variant ever binds a non-execute
 * action, relax this gate accordingly.
 */
const KERNEL_EXECUTE_SELECTOR = '0xe9ae5c53';

export interface PermissionInstallSignal {
  /** The 4-byte permissionId carried in `vId[1..5)`. */
  readonly permissionId: `0x${string}`;
  /** The action selector the permission was bound to (e.g. kernel `execute`). */
  readonly selector: `0x${string}`;
}

/**
 * Decode a kernel `SelectorSet` log into the permission-install signal, or
 * `null` when the log isn't a permission ENABLE we track (wrong event,
 * `allowed=false`, or a non-permission validation type). Pure + total —
 * never throws (a malformed/foreign log returns `null`).
 */
export function decodePermissionInstallFromSelectorSet(
  log: Pick<Log, 'data' | 'topics'>,
): PermissionInstallSignal | null {
  let decoded;
  try {
    decoded = decodeEventLog({
      abi: SELECTOR_SET_EVENT_ABI,
      data: log.data,
      topics: log.topics,
    });
  } catch {
    // Different event with an overlapping topic0, or a malformed log — skip.
    return null;
  }
  if (decoded.eventName !== 'SelectorSet') return null;
  const args = decoded.args as { selector: Hex; vId: Hex; allowed: boolean };
  // `allowed=false` is an unbind (selector removed) — not an install.
  if (!args.allowed) return null;
  const selector = args.selector.toLowerCase() as `0x${string}`;
  // Only the kernel `execute` action binding is a MuHaven Scoped install.
  if (selector !== KERNEL_EXECUTE_SELECTOR) return null;
  const vId = args.vId.toLowerCase();
  // bytes21 → `0x` + 42 hex. Type byte = chars [2,4); permissionId = [4,12).
  if (vId.length !== 2 + 42) return null;
  if (`0x${vId.slice(2, 4)}` !== VALIDATION_TYPE_PERMISSION) return null;
  const permissionId = `0x${vId.slice(4, 12)}` as `0x${string}`;
  return { permissionId, selector };
}
