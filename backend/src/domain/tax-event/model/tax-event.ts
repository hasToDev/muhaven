/**
 * Plaintext tax-event marker per ADR-020. Never holds an encrypted-derived
 * amount — the investor reconstructs amounts client-side using their
 * decrypted handle + recorded NAV.
 */

export type TaxEventType =
  | 'Acquisition'
  | 'Disposition'
  | 'IncomeAccrual'
  | 'FeeEvent'
  // Phase 9.A · Option Z — cash conversions (USDC↔mhUSDC) carrying the
  // encrypted amount handle in metadata for permit-decrypt audit.
  | 'Wrap'
  | 'Unwrap'
  // Phase 9.A · Option Z follow-up — P2P share transfers via
  // `MuHavenToken.Transfer(from, to, amount)`. Two rows per qualifying
  // event (sender + recipient), distinguished by `metadata.direction`.
  | 'Transfer';

/**
 * RWA-related tax-event types — what the `apply-issuer` HAS_INVESTOR_ACTIVITY
 * gate considers "investor history". Cash-rail conversions
 * (`Wrap`/`Unwrap` on MuHavenStable) are deliberately excluded:
 * wrapping USDC into mhUSDC is a payment-rail step, not investor
 * history, and a fresh applicant funding their first RWA buy must not
 * be locked out of issuer onboarding by it.
 *
 * Single source of truth — both the SQL `inArray(...)` filter in
 * `pg-tax-event.repository.ts` and the in-memory test stubs import
 * this constant so adding a new `TaxEventType` enum value forces a
 * deliberate include-or-exclude decision rather than silent drift.
 */
// Mutable array (not `readonly`) so Drizzle's `inArray(...)` overload
// resolves cleanly. Treat it as immutable at the call sites — never
// `.push()` here.
export const INVESTOR_ACTIVITY_EVENT_TYPES: TaxEventType[] = [
  'Acquisition',
  'Disposition',
  'IncomeAccrual',
  'FeeEvent',
  'Transfer',
];

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
