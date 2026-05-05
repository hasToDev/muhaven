/**
 * Device-authorization-grant entity (Wave 4 P3 ADR-3).
 *
 * Lifecycle:
 *   pending  → authorized → consumed
 *           ↘ denied
 *           ↘ expired
 *
 * Status only flips forward — backed by a CHECK in Postgres + a
 * partial-unique index on `userCode WHERE status='pending'`.
 */

export const DeviceCodeStatus = {
  Pending: 'pending',
  Authorized: 'authorized',
  Denied: 'denied',
  Expired: 'expired',
  Consumed: 'consumed',
} as const;

export type DeviceCodeStatus = (typeof DeviceCodeStatus)[keyof typeof DeviceCodeStatus];

export const DEVICE_CODE_STATUS_VALUES: readonly DeviceCodeStatus[] = [
  DeviceCodeStatus.Pending,
  DeviceCodeStatus.Authorized,
  DeviceCodeStatus.Denied,
  DeviceCodeStatus.Expired,
  DeviceCodeStatus.Consumed,
] as const;

export interface RequesterMetadata {
  /** Process / host identifier reported by the broker. */
  processName: string;
  hostname: string;
  os: string;
}

export interface AgentDeviceCodeProps {
  deviceCode: string;
  userCode: string;
  status: DeviceCodeStatus;
  userId: string | null;
  scope: string[] | null;
  jwt: string | null;
  denyReason: string | null;
  requesterMetadata: RequesterMetadata;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export class AgentDeviceCode implements AgentDeviceCodeProps {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly status: DeviceCodeStatus;
  readonly userId: string | null;
  readonly scope: string[] | null;
  readonly jwt: string | null;
  readonly denyReason: string | null;
  readonly requesterMetadata: RequesterMetadata;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;

  constructor(props: AgentDeviceCodeProps) {
    this.deviceCode = props.deviceCode;
    this.userCode = props.userCode;
    this.status = props.status;
    this.userId = props.userId;
    this.scope = props.scope;
    this.jwt = props.jwt;
    this.denyReason = props.denyReason;
    this.requesterMetadata = props.requesterMetadata;
    this.expiresAt = props.expiresAt;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  isExpired(now: Date = new Date()): boolean {
    return now.getTime() >= this.expiresAt.getTime();
  }
}
