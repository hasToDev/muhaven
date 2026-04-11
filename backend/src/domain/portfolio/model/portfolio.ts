export interface PortfolioParams {
  id: string;
  userId: string;
  tokenAddress: string;
  tokenSymbol: string;
  lastSyncedAt?: Date;
}

export class Portfolio {
  readonly id: string;
  readonly userId: string;
  readonly tokenAddress: string;
  readonly tokenSymbol: string;
  lastSyncedAt?: Date;

  constructor(params: PortfolioParams) {
    this.id = params.id;
    this.userId = params.userId;
    this.tokenAddress = params.tokenAddress;
    this.tokenSymbol = params.tokenSymbol;
    this.lastSyncedAt = params.lastSyncedAt;
  }

  markSynced(): this {
    this.lastSyncedAt = new Date();
    return this;
  }
}
