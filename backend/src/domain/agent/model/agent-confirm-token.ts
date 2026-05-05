/**
 * Single-use confirmation token (R-3 mitigation). Bound to
 * `(user_id, action_hash, expires_at)`. `action_hash` is a SHA-256 over
 * the `(action_kind, action_payload)` tuple — re-approve on any change so
 * MCPoison-style description-poisoning replays cannot reuse a token.
 *
 * `consumedAt` flips from null → timestamp atomically on consume; the repo
 * MUST treat the consume as a conditional UPDATE so concurrent attempts
 * race-deterministically (only one wins).
 */
export type ConfirmTokenActionKind =
  | 'tier_transition'
  | 'pause'
  | 'resume'
  | 'permit_grant';

export interface AgentConfirmTokenProps {
  token: string;
  userId: string;
  actionKind: ConfirmTokenActionKind;
  actionHash: string;
  actionPayload: Record<string, unknown>;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export class AgentConfirmToken {
  readonly token: string;
  readonly userId: string;
  readonly actionKind: ConfirmTokenActionKind;
  readonly actionHash: string;
  readonly actionPayload: Record<string, unknown>;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly createdAt: Date;

  constructor(props: AgentConfirmTokenProps) {
    this.token = props.token;
    this.userId = props.userId;
    this.actionKind = props.actionKind;
    this.actionHash = props.actionHash;
    this.actionPayload = props.actionPayload;
    this.expiresAt = props.expiresAt;
    this.consumedAt = props.consumedAt;
    this.createdAt = props.createdAt;
  }

  isExpired(now: Date = new Date()): boolean {
    return this.expiresAt.getTime() <= now.getTime();
  }

  isConsumed(): boolean {
    return this.consumedAt !== null;
  }
}
