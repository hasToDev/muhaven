import type {
  AgentDeviceCode,
  RequesterMetadata,
} from '../model/agent-device-code.js';

export interface IssueDeviceCodeInput {
  deviceCode: string;
  userCode: string;
  requesterMetadata: RequesterMetadata;
  expiresAt: Date;
  now: Date;
}

export interface AuthorizeDeviceCodeInput {
  userCode: string;
  userId: string;
  jwt: string;
  scope: string[];
  now: Date;
}

export interface DenyDeviceCodeInput {
  userCode: string;
  userId: string;
  reason?: string;
  now: Date;
}

/**
 * Repository for the device-authorization-grant table. The `consume`
 * + `authorize` paths must be atomic conditional updates (not
 * read-then-write) — the postgres implementation uses
 * `UPDATE … WHERE status='pending' AND expires_at > now`.
 */
export interface IAgentDeviceCodeRepository {
  /** Insert a fresh pending row. Throws on `userCode` collision. */
  issue(input: IssueDeviceCodeInput): Promise<AgentDeviceCode>;

  /** Look up by deviceCode (broker poll path). */
  findByDeviceCode(deviceCode: string): Promise<AgentDeviceCode | null>;

  /** Look up by userCode (dashboard authorize page). */
  findByUserCode(userCode: string): Promise<AgentDeviceCode | null>;

  /**
   * Atomic flip pending → authorized. Returns the updated row, or null
   * when the row is no longer in `pending` state (race / wrong code /
   * expired / denied / consumed).
   */
  authorize(input: AuthorizeDeviceCodeInput): Promise<AgentDeviceCode | null>;

  /** Atomic flip pending → denied. Returns the updated row or null. */
  deny(input: DenyDeviceCodeInput): Promise<AgentDeviceCode | null>;

  /**
   * Atomic flip authorized → consumed. Returns the JWT iff the flip
   * succeeded; returns null otherwise. The broker calls this on
   * successful poll so the JWT is exposed exactly once.
   */
  consume(deviceCode: string, now: Date): Promise<{ jwt: string; scope: string[] } | null>;

  /**
   * Sweep expired pending / authorized rows to `expired` status.
   * Idempotent. The token endpoint runs this before each poll lookup
   * to keep the response state machine consistent.
   */
  sweepExpired(now: Date): Promise<number>;
}
