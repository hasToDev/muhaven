export type TokenStatus = 'active' | 'paused' | 'winding_down' | 'archived';
export type AssetClass = 'treasury' | 'money_market' | 'private_credit' | 'real_estate' | 'other';

export interface RwaTokenParams {
  id: string;
  address: string;
  name: string;
  symbol: string;
  issuerAddress: string;
  apy?: string;
  yieldSchedule?: string;
  kycTier: number;
  assetClass: AssetClass;
  minInvestment?: string;
  status: TokenStatus;
  createdAt: Date;
  updatedAt: Date;
  pausedAt?: Date;
  windingDownAt?: Date;
  archivedAt?: Date;
}

export class RwaToken {
  readonly id: string;
  readonly address: string;
  readonly name: string;
  readonly symbol: string;
  readonly issuerAddress: string;
  readonly apy?: string;
  readonly yieldSchedule?: string;
  readonly kycTier: number;
  readonly assetClass: AssetClass;
  readonly minInvestment?: string;
  status: TokenStatus;
  readonly createdAt: Date;
  updatedAt: Date;
  pausedAt?: Date;
  windingDownAt?: Date;
  archivedAt?: Date;

  constructor(params: RwaTokenParams) {
    this.id = params.id;
    this.address = params.address;
    this.name = params.name;
    this.symbol = params.symbol;
    this.issuerAddress = params.issuerAddress;
    this.apy = params.apy;
    this.yieldSchedule = params.yieldSchedule;
    this.kycTier = params.kycTier;
    this.assetClass = params.assetClass;
    this.minInvestment = params.minInvestment;
    this.status = params.status;
    this.createdAt = params.createdAt;
    this.updatedAt = params.updatedAt;
    this.pausedAt = params.pausedAt;
    this.windingDownAt = params.windingDownAt;
    this.archivedAt = params.archivedAt;
  }

  // --- Lifecycle state machine ---

  canPause(): boolean {
    return this.status === 'active';
  }

  canUnpause(): boolean {
    return this.status === 'paused';
  }

  canWindDown(): boolean {
    return this.status === 'active' || this.status === 'paused';
  }

  canArchive(): boolean {
    return this.status === 'winding_down';
  }

  pause(): this {
    if (!this.canPause()) {
      throw new Error(`Cannot pause token in '${this.status}' status`);
    }
    this.status = 'paused';
    this.pausedAt = new Date();
    this.updatedAt = new Date();
    return this;
  }

  unpause(): this {
    if (!this.canUnpause()) {
      throw new Error(`Cannot unpause token in '${this.status}' status`);
    }
    this.status = 'active';
    this.updatedAt = new Date();
    return this;
  }

  windDown(): this {
    if (!this.canWindDown()) {
      throw new Error(`Cannot wind down token in '${this.status}' status`);
    }
    this.status = 'winding_down';
    this.windingDownAt = new Date();
    this.updatedAt = new Date();
    return this;
  }

  archive(): this {
    if (!this.canArchive()) {
      throw new Error(`Cannot archive token in '${this.status}' status`);
    }
    this.status = 'archived';
    this.archivedAt = new Date();
    this.updatedAt = new Date();
    return this;
  }
}
