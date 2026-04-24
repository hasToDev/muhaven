/**
 * Plaintext tax-event marker per ADR-020. Never holds an encrypted-derived
 * amount — the investor reconstructs amounts client-side using their
 * decrypted handle + recorded NAV.
 */

export type TaxEventType = 'Acquisition' | 'Disposition' | 'IncomeAccrual' | 'FeeEvent';

export interface TaxEventProps {
  txHash: string;
  logIndex: number;
  eventType: TaxEventType;
  holderAddress: string;
  tokenAddress: string | null;
  blockNumber: string;
  blockTimestamp: Date;
  navAtTime: string | null;
  referenceId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt?: Date;
}

export class TaxEvent {
  readonly txHash: string;
  readonly logIndex: number;
  readonly eventType: TaxEventType;
  readonly holderAddress: string;
  readonly tokenAddress: string | null;
  readonly blockNumber: string;
  readonly blockTimestamp: Date;
  readonly navAtTime: string | null;
  readonly referenceId: string | null;
  readonly metadata: Record<string, unknown> | null;
  readonly createdAt: Date;

  constructor(props: TaxEventProps) {
    this.txHash = props.txHash;
    this.logIndex = props.logIndex;
    this.eventType = props.eventType;
    this.holderAddress = props.holderAddress;
    this.tokenAddress = props.tokenAddress;
    this.blockNumber = props.blockNumber;
    this.blockTimestamp = props.blockTimestamp;
    this.navAtTime = props.navAtTime;
    this.referenceId = props.referenceId;
    this.metadata = props.metadata;
    this.createdAt = props.createdAt ?? new Date();
  }
}
