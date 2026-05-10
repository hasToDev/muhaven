import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  OpenClawIntentEventsChannel,
  formatSseFrame,
  type OpenClawIntentEvent,
} from '../openclaw-intent-events.channel.js';
import type { ServerResponse } from 'node:http';

function fakeRes(): { res: ServerResponse; writes: string[]; throwOnWrite?: boolean } {
  const writes: string[] = [];
  const ctx: { res: ServerResponse; writes: string[]; throwOnWrite?: boolean } = {
    writes,
    res: {
      write: vi.fn((chunk: string) => {
        if (ctx.throwOnWrite) throw new Error('client gone');
        writes.push(chunk);
        return true;
      }),
      end: vi.fn(),
    } as unknown as ServerResponse,
  };
  return ctx;
}

const SAMPLE_EVENT: OpenClawIntentEvent = {
  type: 'intent_confirmed',
  userId: 'u1',
  intentId: 'oci_AAAAAAAAAAAAAAAAAAAAAAAAAA',
  payload: {
    kind: 'buy',
    tier: 'mini_app_otp',
    source: 'mini_app',
    tokenAddress: '0x1111111111111111111111111111111111111111',
    amountUsd6: '2000000',
  },
};

describe('OpenClawIntentEventsChannel', () => {
  let channel: OpenClawIntentEventsChannel;

  beforeEach(() => {
    channel = new OpenClawIntentEventsChannel();
  });

  it('publishes an event to a subscribed user', () => {
    const ctx = fakeRes();
    channel.subscribe('u1', ctx.res);
    const n = channel.publish(SAMPLE_EVENT);
    expect(n).toBe(1);
    expect(ctx.writes).toHaveLength(1);
    expect(ctx.writes[0]).toContain('event: intent_confirmed');
    expect(ctx.writes[0]).toContain('"intentId":"oci_AAAAAAAAAAAAAAAAAAAAAAAAAA"');
    expect(ctx.writes[0]).toContain('"tier":"mini_app_otp"');
  });

  it('does not publish to a different user', () => {
    const ctx = fakeRes();
    channel.subscribe('u2', ctx.res);
    const n = channel.publish(SAMPLE_EVENT);
    expect(n).toBe(0);
    expect(ctx.writes).toHaveLength(0);
  });

  it('publishes to multiple subscribers of the same user (multi-tab)', () => {
    const tabA = fakeRes();
    const tabB = fakeRes();
    channel.subscribe('u1', tabA.res);
    channel.subscribe('u1', tabB.res);
    const n = channel.publish(SAMPLE_EVENT);
    expect(n).toBe(2);
    expect(tabA.writes).toHaveLength(1);
    expect(tabB.writes).toHaveLength(1);
  });

  it('sweeps a subscriber whose write throws', () => {
    const ctx = fakeRes();
    channel.subscribe('u1', ctx.res);
    expect(channel.subscriberCount('u1')).toBe(1);
    ctx.throwOnWrite = true;
    const n = channel.publish(SAMPLE_EVENT);
    expect(n).toBe(0);
    expect(channel.subscriberCount('u1')).toBe(0);
  });

  it('unsubscribe callback removes the subscriber', () => {
    const ctx = fakeRes();
    const unsub = channel.subscribe('u1', ctx.res);
    expect(channel.subscriberCount('u1')).toBe(1);
    unsub();
    expect(channel.subscriberCount('u1')).toBe(0);
    expect(channel.publish(SAMPLE_EVENT)).toBe(0);
  });

  it('subscriberCount(undefined) returns total across all users', () => {
    const a = fakeRes();
    const b = fakeRes();
    channel.subscribe('u1', a.res);
    channel.subscribe('u2', b.res);
    expect(channel.subscriberCount()).toBe(2);
    expect(channel.subscriberCount('u1')).toBe(1);
    expect(channel.subscriberCount('u2')).toBe(1);
  });

  it('publishes intent_denied + intent_consumed event types', () => {
    const ctx = fakeRes();
    channel.subscribe('u1', ctx.res);
    channel.publish({ ...SAMPLE_EVENT, type: 'intent_denied' });
    channel.publish({ ...SAMPLE_EVENT, type: 'intent_consumed' });
    expect(ctx.writes).toHaveLength(2);
    expect(ctx.writes[0]).toContain('event: intent_denied');
    expect(ctx.writes[1]).toContain('event: intent_consumed');
  });
});

describe('formatSseFrame', () => {
  it('renders a valid SSE frame ending in \\n\\n', () => {
    const frame = formatSseFrame(SAMPLE_EVENT);
    expect(frame).toMatch(/\n\n$/);
    expect(frame).toMatch(/^event: intent_confirmed\n/);
  });

  it('includes intentId + payload but NOT userId in the data line (privacy boundary — userId is implicit per subscription)', () => {
    const frame = formatSseFrame(SAMPLE_EVENT);
    expect(frame).toContain('"intentId":');
    expect(frame).toContain('"payload":');
    // userId is NOT in the data line — the channel is per-user-scoped
    // upstream, so emitting it again would be redundant + would surface
    // an inter-tab cross-user audit trail in the page's network tab if
    // the EventSource URL ever leaked. Defense in depth.
    expect(frame).not.toContain('"userId":');
  });
});
