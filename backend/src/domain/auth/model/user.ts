export type WalletProvider = 'zerodev' | 'walletconnect' | 'injected';
export type UserRole = 'investor' | 'issuer';

export interface UserParams {
  id: string;
  walletAddress: string;
  walletProvider: WalletProvider;
  role: UserRole;
  email?: string;
  createdAt: Date;
}

export class User {
  readonly id: string;
  readonly walletAddress: string;
  readonly walletProvider: WalletProvider;
  readonly role: UserRole;
  readonly email?: string;
  readonly createdAt: Date;

  constructor(params: UserParams) {
    this.id = params.id;
    this.walletAddress = params.walletAddress;
    this.walletProvider = params.walletProvider;
    this.role = params.role;
    this.email = params.email;
    this.createdAt = params.createdAt;
  }
}
