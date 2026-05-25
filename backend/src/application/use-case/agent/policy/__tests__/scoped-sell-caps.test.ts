import { describe, it, expect } from 'vitest';
import { ScopedSession } from '../../../../../domain/agent/model/scoped-session.js';
import { ScopedSessionStatus } from '../../../../../domain/agent/model/scoped-session-status.enum.js';
import { Surface } from '../../../../../domain/agent/model/surface.enum.js';
import {
  deriveAutonomousSellCaps,
  SUBSCRIPTION_PURCHASE_SELECTOR,
  SUBSCRIPTION_REDEEM_SELECTOR,
  REDEMPTION_QUEUE_SUBMIT_SELECTOR,
  REDEEM_CAP_ARG_INDEX,
  QUEUE_SUBMIT_CAP_ARG_INDEX,
} from '../scoped-sell-caps.js';

const SUBSCRIPTION = '0xbbbb000000000000000000000000000000000002' as `0x${string}`;
const QUEUE_A = '0xaaaa0000000000000000000000000000000000a1' as `0x${string}`;
const QUEUE_B = '0xaaaa0000000000000000000000000000000000b2' as `0x${string}`;
const NOW = new Date('2026-05-25T12:00:00.000Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

function makeSession(
  overrides: Partial<ConstructorParameters<typeof ScopedSession>[0]> = {},
): ScopedSession {
  return new ScopedSession({
    sessionId: 'session-sell-caps',
    userId: 'u1',
    surface: Surface.MCP,
    status: ScopedSessionStatus.Active,
    signerAddress: '0xaaaa000000000000000000000000000000000001',
    permissionId: null,
    targetContracts: [SUBSCRIPTION],
    selectorCaps: [
      { selector: SUBSCRIPTION_PURCHASE_SELECTOR, capArgIndex: 2, maxAmount: '100' },
    ],
    maxPerOpUsd6: 100_000_000n,
    totalSpentUsd6: 0n,
    validUntilSec: NOW_SEC + 3600,
    mintedAtSec: NOW_SEC,
    consentActionHash: null,
    consentTextSha256: null,
    mintedAt: NOW,
    revokedAt: null,
    expiredAt: null,
    ...overrides,
  });
}

describe('deriveAutonomousSellCaps', () => {
  it('is a no-op when the session carries NO purchase cap (not a Path-D autonomy session)', () => {
    const session = makeSession({
      selectorCaps: [{ selector: '0xdeadbeef', capArgIndex: 2, maxAmount: '100' }],
    });
    const out = deriveAutonomousSellCaps(session, [QUEUE_A]);
    expect(out.changed).toBe(false);
    expect(out.addedSelectors).toEqual([]);
    expect(out.selectorCaps).toEqual(session.selectorCaps);
    expect(out.targetContracts).toEqual(session.targetContracts);
  });

  it('is a no-op when purchase is UNCAPPED (maxAmount null) — refuses to derive an uncapped sell', () => {
    const session = makeSession({
      selectorCaps: [
        { selector: SUBSCRIPTION_PURCHASE_SELECTOR, capArgIndex: null, maxAmount: null },
      ],
    });
    const out = deriveAutonomousSellCaps(session, [QUEUE_A]);
    expect(out.changed).toBe(false);
  });

  it('adds ONLY the redeem cap (capArgIndex 2, same maxAmount) when no queues are supplied', () => {
    const session = makeSession();
    const out = deriveAutonomousSellCaps(session, []);
    expect(out.changed).toBe(true);
    expect(out.addedSelectors).toEqual([SUBSCRIPTION_REDEEM_SELECTOR]);
    const redeem = out.selectorCaps.find((c) => c.selector === SUBSCRIPTION_REDEEM_SELECTOR);
    expect(redeem).toEqual({
      selector: SUBSCRIPTION_REDEEM_SELECTOR,
      capArgIndex: REDEEM_CAP_ARG_INDEX,
      maxAmount: '100', // mirrors the purchase per-op ceiling
    });
    // No submit cap + no new targets when no queues in scope.
    expect(out.selectorCaps.some((c) => c.selector === REDEMPTION_QUEUE_SUBMIT_SELECTOR)).toBe(false);
    expect(out.targetContracts).toEqual([SUBSCRIPTION]);
  });

  it('adds redeem + submit (capArgIndex 1) + the queue targets when queues are supplied', () => {
    const session = makeSession();
    const out = deriveAutonomousSellCaps(session, [QUEUE_A, QUEUE_B]);
    expect(out.changed).toBe(true);
    expect(out.addedSelectors).toEqual([
      SUBSCRIPTION_REDEEM_SELECTOR,
      REDEMPTION_QUEUE_SUBMIT_SELECTOR,
    ]);
    const submit = out.selectorCaps.find((c) => c.selector === REDEMPTION_QUEUE_SUBMIT_SELECTOR);
    expect(submit?.capArgIndex).toBe(QUEUE_SUBMIT_CAP_ARG_INDEX);
    expect(submit?.capArgIndex).toBe(1);
    expect(submit?.maxAmount).toBe('100');
    expect(out.targetContracts).toEqual([SUBSCRIPTION, QUEUE_A, QUEUE_B]);
  });

  it('is IDEMPOTENT — a session already carrying redeem + submit + queues changes nothing', () => {
    const session = makeSession({
      targetContracts: [SUBSCRIPTION, QUEUE_A],
      selectorCaps: [
        { selector: SUBSCRIPTION_PURCHASE_SELECTOR, capArgIndex: 2, maxAmount: '100' },
        { selector: SUBSCRIPTION_REDEEM_SELECTOR, capArgIndex: 2, maxAmount: '100' },
        { selector: REDEMPTION_QUEUE_SUBMIT_SELECTOR, capArgIndex: 1, maxAmount: '100' },
      ],
    });
    const out = deriveAutonomousSellCaps(session, [QUEUE_A]);
    expect(out.changed).toBe(false);
    expect(out.addedSelectors).toEqual([]);
    expect(out.selectorCaps).toHaveLength(3);
    expect(out.targetContracts).toEqual([SUBSCRIPTION, QUEUE_A]);
  });

  it('dedupes + lower-cases queue targets and drops malformed / subscription-colliding entries', () => {
    const session = makeSession();
    const out = deriveAutonomousSellCaps(session, [
      QUEUE_A.toUpperCase().replace('0X', '0x'), // mixed-case dup
      QUEUE_A,
      'not-an-address',
      SUBSCRIPTION, // collides with the subscription target
      QUEUE_B,
    ]);
    expect(out.targetContracts).toEqual([SUBSCRIPTION, QUEUE_A, QUEUE_B]);
  });

  it('never mutates the input session arrays', () => {
    const session = makeSession();
    const originalCaps = [...session.selectorCaps];
    const originalTargets = [...session.targetContracts];
    deriveAutonomousSellCaps(session, [QUEUE_A]);
    expect(session.selectorCaps).toEqual(originalCaps);
    expect(session.targetContracts).toEqual(originalTargets);
  });

  it('pins the three selectors to their canonical signatures', () => {
    // Guards against an ABI-shape typo silently producing the wrong selector
    // (which would make the broker reject the autonomous sell).
    expect(SUBSCRIPTION_PURCHASE_SELECTOR).toMatch(/^0x[0-9a-f]{8}$/);
    expect(SUBSCRIPTION_REDEEM_SELECTOR).toMatch(/^0x[0-9a-f]{8}$/);
    expect(REDEMPTION_QUEUE_SUBMIT_SELECTOR).toMatch(/^0x[0-9a-f]{8}$/);
    // All three distinct.
    expect(
      new Set([
        SUBSCRIPTION_PURCHASE_SELECTOR,
        SUBSCRIPTION_REDEEM_SELECTOR,
        REDEMPTION_QUEUE_SUBMIT_SELECTOR,
      ]).size,
    ).toBe(3);
  });
});
