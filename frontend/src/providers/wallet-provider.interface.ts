import type { PublicClient, WalletClient } from 'viem';

export interface Call {
  to: string;
  data: string;
  value?: bigint;
}

export interface ViemClients {
  publicClient: PublicClient;
  walletClient: WalletClient;
}

export interface IWalletProvider {
  connect(): Promise<string>;
  register(username: string): Promise<string>;
  disconnect(): Promise<void>;
  signMessage(message: string): Promise<string>;
  getAddress(): string | null;
  isConnected(): boolean;
  sendUserOperation(calls: Call[]): Promise<string>;
  /** Return viem clients for SDK integration (cofhe, etc.) */
  getViemClients(): ViemClients | null;
  /** True when a scoped session key is installed + unexpired. Optional — providers without session support return false. */
  hasSessionKey?(): boolean;
  /** Seconds until the installed session key expires. Returns 0 when no session is active. */
  getSessionExpirySeconds?(): number;
  /** Install a scoped session key. No-op if one is already installed. */
  installSessionKey?(): Promise<void>;
  /**
   * Surface the session-key private half for one-time out-of-band copy
   * (e.g., pasting into `MUHAVEN_BROKER_SESSION_KEY` on a different
   * machine). Mints a fresh in-memory record if none exists yet — does
   * NOT trigger an on-chain UserOp. The privateKey is held only in
   * sessionStorage; the backend never sees it (privacy boundary).
   *
   * Returns `null` for providers without session support.
   */
  exportSessionKeyPrivateHalf?(): Promise<ExportedSessionKey | null>;
  /**
   * Wave 5 Path D Slice 1 Pickup A — mint a Scoped session key with a
   * per-op mhUSDC ceiling + user-set TTL. Independent from the in-tab
   * `installSessionKey()` path: generates a fresh ephemeral EOA, builds
   * a `subscription.purchase`-scoped PermissionValidator carrying the
   * `maxSharesHint` cap, and computes `permissionId` locally via the
   * validator's `getIdentifier()` (pure keccak over policy+signer bytes;
   * no on-chain state needed).
   *
   * **Does NOT force an on-chain install at mint time.** The validator
   * is constructed locally so the snapshot can be POSTed to the backend
   * mirror; the actual on-chain `installPlugin` UserOp lands lazily on
   * the first Path D send (Pickup B / Slice 4 carrier).
   *
   * Returns `null` for providers without session support.
   */
  installScopedSessionKey?(opts: InstallScopedSessionInput): Promise<ScopedSessionInstallResult | null>;
}

export interface ExportedSessionKey {
  /** 0x-prefixed 32-byte hex private half. */
  privateKey: `0x${string}`;
  /** ZeroDev kernel smart-account address bound to this session. */
  smartAccountAddress: `0x${string}`;
  /** Unix seconds — when this session key expires (currently 1h default). */
  expiresAtSec: number;
}

export interface InstallScopedSessionInput {
  /** mhUSDC base-6 ceiling — user-intent ceiling per op (display + Slice 5 spend ledger). */
  maxPerOpUsd6: bigint;
  /** Per-selector cap on `maxSharesHint` for subscription.purchase, in WHOLE SHARES
   *  (selector-native unit per PolicySnapshotWire RD-6). Caller converts mhUSDC →
   *  shares via NAV at mint time. */
  maxSharesPerOp: bigint;
  /** TTL in seconds. Caller enforces UI bounds; provider passes through to the
   *  PermissionValidator's TimestampPolicy `validUntil`. */
  ttlSec: number;
}

export interface ScopedSessionInstallResult {
  /** 0x-prefixed 20-byte hex address derived from the ephemeral EOA private key.
   *  Matches the value the operator pastes into `MUHAVEN_BROKER_SESSION_KEY` so
   *  the broker's loaded signer matches `snapshot.signerAddress` per RD-3. */
  signerAddress: `0x${string}`;
  /** 0x-prefixed 32-byte hex secp256k1 private key. SURFACED ONCE for out-of-band
   *  paste; never persisted to localStorage. The caller's modal holds it in a
   *  reactive ref until the operator copies + acknowledges. */
  signerPrivateKey: `0x${string}`;
  /** 0x-prefixed 4-byte hex — `keccak256(policyAndSignerData).slice(0,4)` per
   *  `@zerodev/permissions/toPermissionValidator.ts:71-89`. Captured at mint
   *  time from `permissionValidator.getIdentifier()` (pure derivation, no
   *  on-chain state required).
   *
   *  Carried on the install RESULT so the caller populates it on the
   *  broker IPC / mirror POST. **Pickup B (`buildScopedMintBody`) now
   *  REQUIRES this field on the mint DTO** so the Kernel v3.1 24-byte
   *  nonce-key composite resolves at the broker. Without it the
   *  bundler reads the SUDO-validator nonce slot → AA24 InvalidSigner.
   *  History: Pickup A intentionally omitted it as the smoke checkpoint
   *  (`no_permission_id_in_snapshot`); Pickup B closes the gate. */
  permissionId: `0x${string}`;
  /** Unix seconds when the snapshot was minted (= `Math.floor(Date.now()/1000)`). */
  mintedAtSec: number;
  /** Unix seconds when the snapshot expires (= `mintedAtSec + ttlSec`). */
  validUntilSec: number;
  /** 0x-prefixed 20-byte hex smart-account address — the kernel that will host
   *  the PermissionValidator. Same as the user's existing kernel. Surfaced so
   *  the modal can render it next to the signerAddress without re-deriving. */
  smartAccountAddress: `0x${string}`;
  /**
   * Wave 5 Option D · Commit 2 — install material captured at mint time
   * so the C3 MCP-side MODE.ENABLE UserOp can compose the on-chain
   * validator-install without a second passkey ceremony from the
   * dashboard.
   *
   * `enableData` is `permissionValidator.getEnableData(accountAddress)`
   * — ABI-encoded `(policy[], signer)` payload the kernel unpacks.
   * Pure function over the validator, no on-chain state required.
   *
   * `enableSig` is the passkey-signed
   * `getPluginsEnableTypedData({accountAddress, chainId, kernelVersion:
   * '0.3.1', action: KERNEL_EXECUTE_ACTION, validator: permissionValidator,
   * validatorNonce})` envelope. WebAuthn-shaped (~256-1024 bytes hex)
   * because the SUDO validator on every MuHaven account is
   * `@zerodev/passkey-validator`. Triggers exactly ONE WebAuthn
   * ceremony during the mint flow.
   *
   * `validatorNonce` is the result of `getKernelV3Nonce(publicClient,
   * accountAddress)` at the moment the enableSig was signed. C3's
   * broker pre-check compares this to the live on-chain `currentNonce`
   * before submitting the MODE.ENABLE UserOp — mismatch → fallback
   * `enable_sig_stale`, re-walk the ceremony.
   *
   * All three are tightly bound: changing any of them invalidates the
   * enableSig. The backend mirror stores them encrypted-at-rest via
   * pgcrypto so a DB read leak can't pre-empt the user's install +
   * revoke window.
   */
  enableData: `0x${string}`;
  enableSig: `0x${string}`;
  validatorNonce: number;
}
