/**
 * Session-key resolution for `muhaven-broker setup / start / update`.
 *
 * Wave 5 Option D OPEN-D (2026-05-24). The dashboard mints a Scoped session
 * key (the post-confirm reveal modal); the operator hands it to the broker
 * via `--session <key|->` (scriptable) or an interactive masked paste. The
 * locked UX precedence (BROKER_CLI_PLAN.md "UX decision"):
 *
 *   --session flag  >  interactive prompt  >  (setup-only) self-mint
 *
 * **Key-persistence model is Option B** (operator decision 2026-05-24): the
 * resolved key is injected ONLY into the spawned daemon's child env — it
 * never touches disk. So this module's single job is to RESOLVE the key
 * string; the caller passes it to `spawnDaemon({ env })`. The key is NEVER
 * logged, never echoed, and never embedded in an error message (only its
 * length / prefix shape, which leaks nothing about the secret).
 *
 * Non-TTY safety: when stdin is not a TTY (CI / piped) and no `--session`
 * was supplied, the resolver MUST NOT hang on a prompt — it falls back to
 * self-mint (setup) or returns a clear error (start / update).
 */

/** A valid secp256k1 private key in 0x-prefixed 32-byte hex form. Mirrors
 *  `PRIVKEY_HEX_RE` in `config.ts` (the daemon's own validation). */
const SESSION_KEY_HEX_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Validate the shape of a session key. Returns `null` when valid, else a
 * human-readable error that DOES NOT contain the key bytes — the key is
 * signing material, so we report only its length / prefix shape.
 */
export function validateSessionKeyShape(key: string): string | null {
  if (key.length === 0) return 'session key is empty';
  if (!key.startsWith('0x')) return 'session key must be 0x-prefixed';
  if (!SESSION_KEY_HEX_RE.test(key)) {
    // Length-only diagnostic — never the bytes.
    return `session key must be a 0x-prefixed 32-byte hex string (got ${key.length} chars; expected 66)`;
  }
  return null;
}

export interface SessionPromptDeps {
  /** Whether stdin is an interactive TTY. Non-TTY MUST NOT hang on a prompt. */
  readonly isTty: boolean;
  /** Read all of stdin to a string (for `--session -`). */
  readStdinAll(): Promise<string>;
  /** Ask a yes/no question; defaults to Yes on empty input. */
  promptYesNo(question: string): Promise<boolean>;
  /** Prompt for a secret — the implementation SHOULD mask / not echo it. */
  promptSecret(question: string): Promise<string>;
}

/** start/update REQUIRE a key; setup may fall back to self-mint. */
export type SessionKeyPolicy = 'require' | 'mint-fallback';

export type SessionKeyResolution =
  | { kind: 'key'; key: string }
  | { kind: 'mint' }
  | { kind: 'error'; message: string };

export interface ResolveSessionKeyOptions {
  /** Value of `--session`: a key, the literal `'-'` (stdin), or `undefined`. */
  readonly sessionFlag: string | undefined;
  readonly policy: SessionKeyPolicy;
  readonly deps: SessionPromptDeps;
}

/**
 * Resolve the session key per the locked precedence. Pure-ish: all IO
 * (stdin read, prompts) is injected via `deps` so the decision tree is
 * unit-testable without a TTY.
 */
export async function resolveSessionKey(
  opts: ResolveSessionKeyOptions,
): Promise<SessionKeyResolution> {
  const { sessionFlag, policy, deps } = opts;

  // 1. --session flag (scriptable; skips the prompt entirely).
  if (sessionFlag !== undefined) {
    let raw: string;
    if (sessionFlag === '-') {
      const stdin = await deps.readStdinAll();
      raw = stdin.trim();
      if (raw.length === 0) {
        return { kind: 'error', message: '--session - was given but stdin was empty' };
      }
    } else {
      raw = sessionFlag.trim();
    }
    const shapeErr = validateSessionKeyShape(raw);
    if (shapeErr) return { kind: 'error', message: shapeErr };
    return { kind: 'key', key: raw };
  }

  // 2. No flag, non-TTY: never hang on a prompt.
  if (!deps.isTty) {
    if (policy === 'mint-fallback') return { kind: 'mint' };
    return {
      kind: 'error',
      message:
        'no session key provided and stdin is not a TTY — pass --session <key> ' +
        '(or `--session -` to pipe it), or run `muhaven-broker setup` to mint a fresh key',
    };
  }

  // 3. Interactive prompt.
  const hasKey = await deps.promptYesNo(
    'Do you have a session key from the dashboard? [Y/n] ',
  );
  if (!hasKey) {
    if (policy === 'mint-fallback') return { kind: 'mint' };
    return {
      kind: 'error',
      message:
        'a session key is required for this command — paste the dashboard-minted key, ' +
        'or run `muhaven-broker setup` to mint one',
    };
  }
  const pasted = (await deps.promptSecret('Paste the session key: ')).trim();
  const shapeErr = validateSessionKeyShape(pasted);
  if (shapeErr) {
    return {
      kind: 'error',
      message: `${shapeErr} — re-run and paste the key from the dashboard's session-reveal modal`,
    };
  }
  return { kind: 'key', key: pasted };
}
