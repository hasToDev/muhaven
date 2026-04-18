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
}
