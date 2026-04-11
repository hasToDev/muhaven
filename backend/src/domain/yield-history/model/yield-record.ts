export type YieldStatus = 'pending' | 'claimable' | 'claimed' | 'expired';

export interface YieldRecordParams {
  id: string;
  userId: string;
  distributionId: number;
  escrowId?: string;
  tokenAddress: string;
  amount?: string;
  status: YieldStatus;
  claimedAt?: Date;
  createdAt: Date;
}

export class YieldRecord {
  readonly id: string;
  readonly userId: string;
  readonly distributionId: number;
  readonly escrowId?: string;
  readonly tokenAddress: string;
  readonly amount?: string;
  status: YieldStatus;
  claimedAt?: Date;
  readonly createdAt: Date;

  constructor(params: YieldRecordParams) {
    this.id = params.id;
    this.userId = params.userId;
    this.distributionId = params.distributionId;
    this.escrowId = params.escrowId;
    this.tokenAddress = params.tokenAddress;
    this.amount = params.amount;
    this.status = params.status;
    this.claimedAt = params.claimedAt;
    this.createdAt = params.createdAt;
  }

  markClaimable(): this {
    this.status = 'claimable';
    return this;
  }

  markClaimed(): this {
    this.status = 'claimed';
    this.claimedAt = new Date();
    return this;
  }

  markExpired(): this {
    this.status = 'expired';
    return this;
  }
}
