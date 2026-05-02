export type WalletProvider = 'zerodev' | 'walletconnect' | 'injected';
export type UserRole = 'investor' | 'issuer';
export type IssuerStatus = 'unregistered' | 'pending' | 'approved' | 'suspended';

/**
 * Phase 9.A · Expansion (F2) — raw payload captured from the wizard so a
 * future KYB-review queue can replay what the applicant submitted. Today
 * the wizard auto-approves; the row is informational only.
 */
export interface IssuerKybSubmission {
  display_name: string;
  jurisdiction: string;
  contact_email: string;
  attestation: 'kyb_skipped';
  submitted_at: string;
}

export interface UserParams {
  id: string;
  walletAddress: string;
  walletProvider: WalletProvider;
  role: UserRole;
  email?: string;
  createdAt: Date;
  issuerStatus?: IssuerStatus;
  issuerDisplayName?: string;
  issuerJurisdiction?: string;
  issuerApprovedAt?: Date;
  issuerKybSubmission?: IssuerKybSubmission;
}

export class User {
  readonly id: string;
  readonly walletAddress: string;
  readonly walletProvider: WalletProvider;
  readonly role: UserRole;
  readonly email?: string;
  readonly createdAt: Date;
  readonly issuerStatus: IssuerStatus;
  readonly issuerDisplayName?: string;
  readonly issuerJurisdiction?: string;
  readonly issuerApprovedAt?: Date;
  readonly issuerKybSubmission?: IssuerKybSubmission;

  constructor(params: UserParams) {
    this.id = params.id;
    this.walletAddress = params.walletAddress;
    this.walletProvider = params.walletProvider;
    this.role = params.role;
    this.email = params.email;
    this.createdAt = params.createdAt;
    this.issuerStatus = params.issuerStatus ?? 'unregistered';
    this.issuerDisplayName = params.issuerDisplayName;
    this.issuerJurisdiction = params.issuerJurisdiction;
    this.issuerApprovedAt = params.issuerApprovedAt;
    this.issuerKybSubmission = params.issuerKybSubmission;
  }
}
