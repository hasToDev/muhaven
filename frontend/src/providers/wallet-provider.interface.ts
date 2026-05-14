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
}

export interface ExportedSessionKey {
  /** 0x-prefixed 32-byte hex private half. */
  privateKey: `0x${string}`;
  /** ZeroDev kernel smart-account address bound to this session. */
  smartAccountAddress: `0x${string}`;
  /** Unix seconds — when this session key expires (currently 1h default). */
  expiresAtSec: number;
}
