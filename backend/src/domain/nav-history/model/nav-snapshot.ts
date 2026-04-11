export type NavSourceType = 'on_chain' | 'api' | 'manual';

export interface NavSnapshotParams {
  id: string;
  tokenAddress: string;
  nav: string;
  apy?: string;
  totalAum?: string;
  yieldRate?: string;
  source: string;
  sourceType: NavSourceType;
  sourceTimestamp?: Date;
  fetchedAt: Date;
  createdAt: Date;
}

export class NavSnapshot {
  readonly id: string;
  readonly tokenAddress: string;
  readonly nav: string;
  readonly apy?: string;
  readonly totalAum?: string;
  readonly yieldRate?: string;
  readonly source: string;
  readonly sourceType: NavSourceType;
  readonly sourceTimestamp?: Date;
  readonly fetchedAt: Date;
  readonly createdAt: Date;

  constructor(params: NavSnapshotParams) {
    this.id = params.id;
    this.tokenAddress = params.tokenAddress;
    this.nav = params.nav;
    this.apy = params.apy;
    this.totalAum = params.totalAum;
    this.yieldRate = params.yieldRate;
    this.source = params.source;
    this.sourceType = params.sourceType;
    this.sourceTimestamp = params.sourceTimestamp;
    this.fetchedAt = params.fetchedAt;
    this.createdAt = params.createdAt;
  }
}
