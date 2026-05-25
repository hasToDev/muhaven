import { describe, it, expect } from 'vitest';
import { agentAuditEventTypeEnum } from '../schema.js';
import { AUDIT_EVENT_TYPE_VALUES } from '../../../../domain/agent/model/audit-event-type.enum.js';

/**
 * Lockstep guard between the TypeScript `AuditEventType` enum and the Postgres
 * `agent_audit_event_type` pgEnum. There have been TWO drift incidents where a
 * TS value was added without the matching pgEnum value (`validator_install_failed`,
 * then nearly again for `scoped_session_sell_caps_derived`): the audit INSERT
 * throws `invalid input value for enum` at runtime, caught only by best-effort
 * try/catch. This test makes the drift a CI failure instead. (BE Arch review,
 * Wave 5 Slice 1.)
 */
describe('audit-event-type ↔ pgEnum lockstep', () => {
  const pgValues = new Set<string>(agentAuditEventTypeEnum.enumValues);

  it('every TypeScript AuditEventType value exists in the pgEnum', () => {
    const missing = AUDIT_EVENT_TYPE_VALUES.filter((v) => !pgValues.has(v));
    expect(missing, `TS audit values missing from the pgEnum: ${missing.join(', ')}`).toEqual([]);
  });

  it('includes the Wave 5 Slice 1 scoped_session_sell_caps_derived value on both sides', () => {
    expect(AUDIT_EVENT_TYPE_VALUES).toContain('scoped_session_sell_caps_derived');
    expect(pgValues.has('scoped_session_sell_caps_derived')).toBe(true);
  });
});
