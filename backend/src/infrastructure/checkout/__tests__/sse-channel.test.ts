import { describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import { formatSseFrame, SseChannelService } from '../sse-channel.js';

function fakeResponse(): { res: ServerResponse; chunks: string[] } {
  const chunks: string[] = [];
  const res = {
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    end: () => {
      // no-op
    },
  } as unknown as ServerResponse;
  return { res, chunks };
}

describe('SseChannelService', () => {
  it('publishes events to subscribers of the matching session', () => {
    const channel = new SseChannelService();
    const a = fakeResponse();
    const b = fakeResponse();
    channel.subscribe('cs_AAA', a.res);
    channel.subscribe('cs_BBB', b.res);
    const n = channel.publish({
      type: 'funded',
      sessionId: 'cs_AAA',
      data: { status: 'funded' },
    });
    expect(n).toBe(1);
    expect(a.chunks).toHaveLength(1);
    expect(a.chunks[0]).toContain('event: funded');
    expect(a.chunks[0]).toContain('"sessionId":"cs_AAA"');
    expect(b.chunks).toHaveLength(0);
  });

  it('fan-outs to multiple subscribers of the same session', () => {
    const channel = new SseChannelService();
    const a = fakeResponse();
    const b = fakeResponse();
    channel.subscribe('cs_AAA', a.res);
    channel.subscribe('cs_AAA', b.res);
    const n = channel.publish({
      type: 'wrapped',
      sessionId: 'cs_AAA',
      data: { status: 'wrapped' },
    });
    expect(n).toBe(2);
    expect(a.chunks).toHaveLength(1);
    expect(b.chunks).toHaveLength(1);
  });

  it('removes subscribers on unsubscribe', () => {
    const channel = new SseChannelService();
    const a = fakeResponse();
    const unsub = channel.subscribe('cs_AAA', a.res);
    expect(channel.subscriberCount('cs_AAA')).toBe(1);
    unsub();
    expect(channel.subscriberCount('cs_AAA')).toBe(0);
    const n = channel.publish({
      type: 'wrapped',
      sessionId: 'cs_AAA',
      data: { status: 'wrapped' },
    });
    expect(n).toBe(0);
  });

  it('drops subscribers whose write throws (aborted client)', () => {
    const channel = new SseChannelService();
    const broken = {
      write: () => {
        throw new Error('client gone');
      },
      end: () => {
        // no-op
      },
    } as unknown as ServerResponse;
    channel.subscribe('cs_AAA', broken);
    expect(channel.subscriberCount('cs_AAA')).toBe(1);
    channel.publish({
      type: 'funded',
      sessionId: 'cs_AAA',
      data: {},
    });
    expect(channel.subscriberCount('cs_AAA')).toBe(0);
  });

  it('closeSession ends every subscriber for the id', () => {
    const channel = new SseChannelService();
    const a = fakeResponse();
    const b = fakeResponse();
    channel.subscribe('cs_AAA', a.res);
    channel.subscribe('cs_AAA', b.res);
    const n = channel.closeSession('cs_AAA');
    expect(n).toBe(2);
    expect(channel.subscriberCount('cs_AAA')).toBe(0);
  });
});

describe('formatSseFrame', () => {
  it('formats a frame as `event: <type>\\ndata: <json>\\n\\n`', () => {
    const frame = formatSseFrame({
      type: 'settled',
      sessionId: 'cs_AAA',
      data: { foo: 1 },
    });
    expect(frame).toBe(
      'event: settled\ndata: {"type":"settled","sessionId":"cs_AAA","data":{"foo":1}}\n\n',
    );
  });

  it('JSON-escapes newlines inside data so the frame stays one line', () => {
    const frame = formatSseFrame({
      type: 'failed',
      sessionId: 'cs_AAA',
      data: { reason: 'a\nb' },
    });
    // Only the trailing `\n\n` after the frame should appear; the
    // payload's newline is already escaped to `\\n` in JSON.
    const dataLine = frame.split('\n').filter((l) => l.startsWith('data: '));
    expect(dataLine).toHaveLength(1);
  });
});
