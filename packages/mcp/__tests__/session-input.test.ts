import { describe, expect, it, vi } from 'vitest';
import {
  resolveSessionKey,
  validateSessionKeyShape,
  type SessionPromptDeps,
} from '../src/broker/session-input.js';

const VALID_KEY = '0x' + 'ab'.repeat(32);

describe('validateSessionKeyShape', () => {
  it('accepts a 0x-prefixed 32-byte hex key (lower + upper hex)', () => {
    expect(validateSessionKeyShape('0x' + 'ab'.repeat(32))).toBeNull();
    expect(validateSessionKeyShape('0x' + 'AB'.repeat(32))).toBeNull();
    expect(validateSessionKeyShape('0x' + '0123456789abcdefABCDEF'.padEnd(64, '0'))).toBeNull();
  });

  it('rejects empty / missing 0x / wrong length / non-hex', () => {
    expect(validateSessionKeyShape('')).toMatch(/empty/);
    expect(validateSessionKeyShape('ab'.repeat(32))).toMatch(/0x-prefixed/);
    expect(validateSessionKeyShape('0x' + 'ab'.repeat(20))).toMatch(/32-byte hex/);
    expect(validateSessionKeyShape('0x' + 'ab'.repeat(40))).toMatch(/32-byte hex/);
    expect(validateSessionKeyShape('0x' + 'zz'.repeat(32))).toMatch(/32-byte hex/);
  });

  it('NEVER includes the key bytes in the error message (signing material)', () => {
    const sneaky = '0x' + 'de'.repeat(40); // wrong length but real-looking
    const err = validateSessionKeyShape(sneaky)!;
    expect(err).not.toContain(sneaky);
    expect(err).not.toContain('de'.repeat(40));
    // length-only diagnostic is OK
    expect(err).toMatch(/got \d+ chars/);
  });
});

function makeDeps(overrides: Partial<SessionPromptDeps> = {}): SessionPromptDeps {
  return {
    isTty: false,
    readStdinAll: vi.fn(async () => ''),
    promptYesNo: vi.fn(async () => false),
    promptSecret: vi.fn(async () => ''),
    ...overrides,
  };
}

describe('resolveSessionKey — --session flag (scriptable)', () => {
  it('uses a valid --session value without prompting', async () => {
    const deps = makeDeps({ isTty: true });
    const r = await resolveSessionKey({ sessionFlag: VALID_KEY, policy: 'require', deps });
    expect(r).toEqual({ kind: 'key', key: VALID_KEY });
    expect(deps.promptYesNo).not.toHaveBeenCalled();
    expect(deps.promptSecret).not.toHaveBeenCalled();
  });

  it('trims surrounding whitespace from the flag value', async () => {
    const deps = makeDeps();
    const r = await resolveSessionKey({
      sessionFlag: `  ${VALID_KEY}\n`,
      policy: 'require',
      deps,
    });
    expect(r).toEqual({ kind: 'key', key: VALID_KEY });
  });

  it('rejects an invalid --session value (error carries no key bytes)', async () => {
    const deps = makeDeps();
    const bad = '0x' + 'ab'.repeat(20);
    const r = await resolveSessionKey({ sessionFlag: bad, policy: 'require', deps });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.message).toMatch(/32-byte hex/);
      expect(r.message).not.toContain(bad);
    }
  });

  it('--session - reads + trims the key from stdin', async () => {
    const readStdinAll = vi.fn(async () => `${VALID_KEY}\n`);
    const deps = makeDeps({ readStdinAll });
    const r = await resolveSessionKey({ sessionFlag: '-', policy: 'require', deps });
    expect(r).toEqual({ kind: 'key', key: VALID_KEY });
    expect(readStdinAll).toHaveBeenCalledTimes(1);
  });

  it('--session - with empty stdin returns an error (no hang)', async () => {
    const deps = makeDeps({ readStdinAll: vi.fn(async () => '   \n') });
    const r = await resolveSessionKey({ sessionFlag: '-', policy: 'require', deps });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toMatch(/stdin was empty/);
  });
});

describe('resolveSessionKey — non-TTY (CI / piped)', () => {
  it('mint-fallback (setup) → mint, never hangs', async () => {
    const deps = makeDeps({ isTty: false });
    const r = await resolveSessionKey({ sessionFlag: undefined, policy: 'mint-fallback', deps });
    expect(r).toEqual({ kind: 'mint' });
    expect(deps.promptYesNo).not.toHaveBeenCalled();
  });

  it('require (start/update) → error pointing at --session, never hangs', async () => {
    const deps = makeDeps({ isTty: false });
    const r = await resolveSessionKey({ sessionFlag: undefined, policy: 'require', deps });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.message).toMatch(/--session/);
      expect(r.message).toMatch(/not a TTY/);
    }
    expect(deps.promptYesNo).not.toHaveBeenCalled();
  });
});

describe('resolveSessionKey — interactive TTY prompt', () => {
  it('Yes + valid paste → key', async () => {
    const deps = makeDeps({
      isTty: true,
      promptYesNo: vi.fn(async () => true),
      promptSecret: vi.fn(async () => VALID_KEY),
    });
    const r = await resolveSessionKey({ sessionFlag: undefined, policy: 'require', deps });
    expect(r).toEqual({ kind: 'key', key: VALID_KEY });
    expect(deps.promptYesNo).toHaveBeenCalledTimes(1);
    expect(deps.promptSecret).toHaveBeenCalledTimes(1);
  });

  it('Yes + invalid paste → error (no key bytes, re-run guidance)', async () => {
    const bad = 'not-a-key';
    const deps = makeDeps({
      isTty: true,
      promptYesNo: vi.fn(async () => true),
      promptSecret: vi.fn(async () => bad),
    });
    const r = await resolveSessionKey({ sessionFlag: undefined, policy: 'require', deps });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.message).not.toContain(bad);
      expect(r.message).toMatch(/re-run/);
    }
  });

  it('No + mint-fallback (setup) → mint', async () => {
    const deps = makeDeps({ isTty: true, promptYesNo: vi.fn(async () => false) });
    const r = await resolveSessionKey({ sessionFlag: undefined, policy: 'mint-fallback', deps });
    expect(r).toEqual({ kind: 'mint' });
    expect(deps.promptSecret).not.toHaveBeenCalled();
  });

  it('No + require (start/update) → error pointing at setup', async () => {
    const deps = makeDeps({ isTty: true, promptYesNo: vi.fn(async () => false) });
    const r = await resolveSessionKey({ sessionFlag: undefined, policy: 'require', deps });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toMatch(/muhaven-broker setup/);
    expect(deps.promptSecret).not.toHaveBeenCalled();
  });

  it('trims the pasted key', async () => {
    const deps = makeDeps({
      isTty: true,
      promptYesNo: vi.fn(async () => true),
      promptSecret: vi.fn(async () => `  ${VALID_KEY}  `),
    });
    const r = await resolveSessionKey({ sessionFlag: undefined, policy: 'require', deps });
    expect(r).toEqual({ kind: 'key', key: VALID_KEY });
  });
});
