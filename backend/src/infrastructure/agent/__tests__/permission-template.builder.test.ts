import { describe, it, expect } from 'vitest';
import {
  buildPermissionTemplate,
  serializeTemplate,
  KNOWN_SELECTORS,
} from '../permission-template.builder.js';
import { Tier } from '../../../domain/agent/model/tier.enum.js';
import { ActionId } from '../../../domain/agent/model/action-id.enum.js';

const SUB = '0x0000000000000000000000000000000000000001' as const;
const QUEUE = '0x0000000000000000000000000000000000000002' as const;
const SNAPSHOT = '0x0000000000000000000000000000000000000003' as const;

const NOW = new Date('2026-04-30T00:00:00.000Z');

describe('buildPermissionTemplate', () => {
  it('Advisory tier returns an empty template — no session key minted', () => {
    const t = buildPermissionTemplate({
      tier: Tier.Advisory,
      actions: [ActionId.Buy],
      contracts: { subscription: SUB },
      now: NOW,
    });
    expect(t.callPolicy).toEqual([]);
    expect(t.gasPolicy.totalGasLimit).toBe(0n);
    expect(t.rateLimitPolicy.count).toBe(0);
    expect(t.actions).toEqual([]);
  });

  it('ConfirmPerAction tier returns an empty template — same as Advisory', () => {
    const t = buildPermissionTemplate({
      tier: Tier.ConfirmPerAction,
      actions: [ActionId.Buy, ActionId.Sell],
      contracts: { subscription: SUB, redemptionQueue: QUEUE },
      now: NOW,
    });
    expect(t.callPolicy).toEqual([]);
    expect(t.actions).toEqual([]);
  });

  it('PolicyBound: Buy alone produces one CallPolicy entry', () => {
    const t = buildPermissionTemplate({
      tier: Tier.PolicyBound,
      actions: [ActionId.Buy],
      contracts: { subscription: SUB },
      now: NOW,
    });
    expect(t.callPolicy.length).toBe(1);
    expect(t.callPolicy[0].target).toBe(SUB);
    expect(t.callPolicy[0].selectors).toEqual([KNOWN_SELECTORS.subscriptionBuy]);
    expect(t.callPolicy[0].valueLimitWei).toBe(0n);
  });

  it('PolicyBound: Buy + Sell + Claim produces 3 distinct entries', () => {
    const t = buildPermissionTemplate({
      tier: Tier.PolicyBound,
      actions: [ActionId.Buy, ActionId.Sell, ActionId.Claim],
      contracts: { subscription: SUB, redemptionQueue: QUEUE, yieldSnapshot: SNAPSHOT },
      now: NOW,
    });
    expect(t.callPolicy.length).toBe(3);
    const targets = t.callPolicy.map((e) => e.target).sort();
    expect(targets).toEqual([SUB, QUEUE, SNAPSHOT].sort());
  });

  it('PolicyBound: Rebalance + Buy + Sell deduplicates to 2 entries', () => {
    const t = buildPermissionTemplate({
      tier: Tier.PolicyBound,
      actions: [ActionId.Rebalance, ActionId.Buy, ActionId.Sell],
      contracts: { subscription: SUB, redemptionQueue: QUEUE },
      now: NOW,
    });
    // Subscription appears once (Buy + Rebalance both hit it);
    // RedemptionQueue appears once (Sell + Rebalance both hit it).
    expect(t.callPolicy.length).toBe(2);
    const targets = t.callPolicy.map((e) => e.target).sort();
    expect(targets).toEqual([SUB, QUEUE].sort());
    // Each entry's selectors are deduplicated too
    for (const entry of t.callPolicy) {
      expect(entry.selectors.length).toBe(new Set(entry.selectors).size);
    }
  });

  it('missing contract addresses are silently dropped', () => {
    const t = buildPermissionTemplate({
      tier: Tier.PolicyBound,
      actions: [ActionId.Buy, ActionId.Sell],
      contracts: { subscription: SUB }, // no redemptionQueue
      now: NOW,
    });
    expect(t.callPolicy.length).toBe(1);
    expect(t.callPolicy[0].target).toBe(SUB);
  });

  it('validUntilSec respects ttlSec input', () => {
    const t = buildPermissionTemplate({
      tier: Tier.PolicyBound,
      actions: [ActionId.Buy],
      contracts: { subscription: SUB },
      ttlSec: 7200,
      now: NOW,
    });
    const expected = Math.floor(NOW.getTime() / 1000) + 7200;
    expect(t.validUntilSec).toBe(expected);
  });
});

describe('serializeTemplate', () => {
  it('stringifies bigints to decimal strings — JSON-safe', () => {
    const t = buildPermissionTemplate({
      tier: Tier.PolicyBound,
      actions: [ActionId.Buy],
      contracts: { subscription: SUB },
      now: NOW,
    });
    const serialized = serializeTemplate(t) as Record<string, unknown>;
    const gas = serialized.gasPolicy as Record<string, unknown>;
    expect(typeof gas.totalGasLimit).toBe('string');
    expect(gas.totalGasLimit).toBe('5000000');
    const cp = (serialized.callPolicy as Array<Record<string, unknown>>)[0];
    expect(typeof cp.valueLimitWei).toBe('string');
    expect(cp.valueLimitWei).toBe('0');
    // Sanity: the whole structure round-trips through JSON.stringify
    expect(() => JSON.stringify(serialized)).not.toThrow();
  });
});
