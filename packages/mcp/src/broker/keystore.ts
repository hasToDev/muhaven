/**
 * Cross-platform JWT keystore for the broker daemon.
 *
 * Two backends per ADR-3 D3:
 *  - **OS keychain** (default) via `@napi-rs/keyring` — Windows DPAPI /
 *    Credential Manager / macOS Security framework / Linux Secret
 *    Service via D-Bus.
 *  - **File** (opt-in via `MUHAVEN_KEYRING=file`) — JSON file at
 *    `~/.muhaven/jwt`, mode 0600, parent dir mode 0700. Required for
 *    WSL2 / devcontainer / SSH-remote where Secret Service is absent.
 *
 * The interface is intentionally tiny — the broker daemon never inspects
 * a JWT, only stores / fetches / clears it.
 */

import { chmod, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const KEYRING_SERVICE = 'muhaven.mcp';
const KEYRING_ACCOUNT = 'jwt';

interface JwtRecord {
  jwt: string;
  expiresAtSec: number | null;
  storedAtSec: number;
}

export type KeystoreBackend = 'os' | 'file';

export interface IKeystore {
  readonly backend: KeystoreBackend;
  readonly available: boolean;
  set(record: JwtRecord): Promise<void>;
  get(): Promise<JwtRecord | null>;
  clear(): Promise<void>;
}

/** Internal: dynamic import so the package builds even when @napi-rs/keyring
 *  has no prebuilt for the dev machine. Typed as `unknown` to keep the
 *  package compilable without an installed binding. */
async function loadKeyringModule(): Promise<{ Entry?: unknown } | null> {
  try {
    // The string is computed so tsc doesn't try to resolve the module at
    // type-check time when @napi-rs/keyring is absent in dev.
    const moduleName = '@napi-rs/keyring';
    return (await import(moduleName)) as { Entry?: unknown };
  } catch {
    return null;
  }
}

class OsKeystore implements IKeystore {
  readonly backend: KeystoreBackend = 'os';
  available = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly entry: any) {}

  async set(record: JwtRecord): Promise<void> {
    try {
      this.entry.setPassword(JSON.stringify(record));
    } catch (err) {
      this.available = false;
      throw new KeystoreError(
        'os_keystore_unavailable',
        `OS keychain rejected write — ${asMessage(err)}. ` +
          'Try MUHAVEN_KEYRING=file or run `muhaven-broker doctor`.',
        err,
      );
    }
  }

  async get(): Promise<JwtRecord | null> {
    try {
      const raw = this.entry.getPassword();
      if (!raw) return null;
      return parseRecord(raw);
    } catch (err) {
      this.available = false;
      throw new KeystoreError(
        'os_keystore_unavailable',
        `OS keychain read failed — ${asMessage(err)}. ` +
          'Try MUHAVEN_KEYRING=file or run `muhaven-broker doctor`.',
        err,
      );
    }
  }

  async clear(): Promise<void> {
    try {
      this.entry.deletePassword();
    } catch (err) {
      // deletePassword on a missing entry can throw on some platforms;
      // treat as a no-op rather than surfacing.
      void err;
    }
  }
}

class FileKeystore implements IKeystore {
  readonly backend: KeystoreBackend = 'file';
  readonly available = true;

  constructor(private readonly path: string) {}

  static defaultPath(): string {
    return join(homedir(), '.muhaven', 'jwt');
  }

  async set(record: JwtRecord): Promise<void> {
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700).catch(() => undefined);
    await writeFile(this.path, JSON.stringify(record), { mode: 0o600 });
    await chmod(this.path, 0o600).catch(() => undefined);
  }

  async get(): Promise<JwtRecord | null> {
    try {
      const raw = await readFile(this.path, 'utf8');
      return parseRecord(raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new KeystoreError('file_read_failed', asMessage(err), err);
    }
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new KeystoreError('file_clear_failed', asMessage(err), err);
    }
  }
}

export type KeystoreErrorCode =
  | 'os_keystore_unavailable'
  | 'file_read_failed'
  | 'file_clear_failed'
  | 'malformed_record';

export class KeystoreError extends Error {
  constructor(readonly code: KeystoreErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'KeystoreError';
  }
}

function parseRecord(raw: string): JwtRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<JwtRecord>;
    if (!parsed || typeof parsed.jwt !== 'string') return null;
    return {
      jwt: parsed.jwt,
      expiresAtSec: typeof parsed.expiresAtSec === 'number' ? parsed.expiresAtSec : null,
      storedAtSec: typeof parsed.storedAtSec === 'number' ? parsed.storedAtSec : 0,
    };
  } catch {
    throw new KeystoreError('malformed_record', 'keystore record is not valid JSON');
  }
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface OpenKeystoreOptions {
  /** When 'file', force the file backend regardless of OS support. */
  preferred?: KeystoreBackend;
  /** Override default file path (testing / Docker volumes). */
  filePath?: string;
}

/**
 * Pick a keystore backend. Order:
 *   1. `MUHAVEN_KEYRING=file` env or `preferred='file'` → FileKeystore.
 *   2. `@napi-rs/keyring` import succeeds + `getPassword()` doesn't throw → OsKeystore.
 *   3. Fall back to FileKeystore (with a warning the caller can surface).
 *
 * Returns the keystore + whether a fallback was applied so the caller
 * can print a doctor-style warning.
 */
export async function openKeystore(
  options: OpenKeystoreOptions = {},
): Promise<{ keystore: IKeystore; fallbackReason: string | null }> {
  const envPref = process.env.MUHAVEN_KEYRING?.toLowerCase();
  const wantFile = options.preferred === 'file' || envPref === 'file';
  const filePath = options.filePath ?? FileKeystore.defaultPath();

  if (wantFile) {
    return { keystore: new FileKeystore(filePath), fallbackReason: null };
  }

  const mod = await loadKeyringModule();
  if (!mod) {
    return {
      keystore: new FileKeystore(filePath),
      fallbackReason: '@napi-rs/keyring not installed for this platform',
    };
  }

  // Probe — `new Entry(...)` is cheap; the real failure mode is the
  // first read/write call throwing. Try a probe read to detect Secret
  // Service unavailability on WSL2 / devcontainer up front.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Entry: any = (mod as { Entry?: unknown }).Entry;
  if (!Entry) {
    return {
      keystore: new FileKeystore(filePath),
      fallbackReason: '@napi-rs/keyring loaded but Entry constructor missing',
    };
  }
  let entry: unknown;
  try {
    entry = new Entry(KEYRING_SERVICE, KEYRING_ACCOUNT);
    // Probe read — and validate the shape if present. A corrupted record
    // (wrong-version JSON, partial write from a prior broker, or a value
    // some other tool stored under the same KEYRING_SERVICE+ACCOUNT pair)
    // would otherwise pass the probe and surface only at the first MCP
    // call as `keystore_unavailable`. See MCP_PUBLISH_READINESS.md §2.3
    // (H-3).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (entry as any).getPassword();
    if (raw && typeof raw === 'string') {
      // parseRecord throws KeystoreError('malformed_record') on bad JSON;
      // returns null on JSON-but-wrong-shape (no jwt field). Both are
      // 'corrupted' for our purposes — fall back to the file backend so
      // `muhaven-broker login` can re-mint cleanly without the operator
      // first having to manually clear the OS keychain entry.
      const parsed = parseRecord(raw);
      if (parsed === null) {
        return {
          keystore: new FileKeystore(filePath),
          fallbackReason:
            'OS keychain held a record that did not contain a recognizable JWT — falling back to file. ' +
            'Run `muhaven-broker logout` if you want to clean it up.',
        };
      }
    }
  } catch (err) {
    // Distinguish parseRecord throws (malformed_record — bad JSON in the
    // OS keychain slot) from getPassword throws (Secret Service down,
    // DPAPI permission issue, etc.) so the doctor diagnostic can be
    // specific.
    const isMalformed = err instanceof KeystoreError && err.code === 'malformed_record';
    return {
      keystore: new FileKeystore(filePath),
      fallbackReason: isMalformed
        ? `OS keychain held a malformed JWT record — falling back to file. ${asMessage(err)}`
        : `OS keychain probe failed: ${asMessage(err)}`,
    };
  }

  return { keystore: new OsKeystore(entry), fallbackReason: null };
}

/**
 * Test-only entrypoint. Bypasses the dynamic `@napi-rs/keyring` import
 * so unit tests can inject a fake Entry that returns canned probe values
 * (malformed JSON / wrong-shape JSON / empty / valid). Mirrors the live
 * probe path in `openKeystore` exactly — keep them in sync.
 */
export async function openKeystoreForTest(
  mockEntry: { getPassword: () => unknown; setPassword?: (v: string) => void; deletePassword?: () => void },
  options: OpenKeystoreOptions = {},
): Promise<{ keystore: IKeystore; fallbackReason: string | null }> {
  const filePath = options.filePath ?? FileKeystore.defaultPath();
  try {
    const raw = mockEntry.getPassword();
    if (raw && typeof raw === 'string') {
      const parsed = parseRecord(raw);
      if (parsed === null) {
        return {
          keystore: new FileKeystore(filePath),
          fallbackReason:
            'OS keychain held a record that did not contain a recognizable JWT — falling back to file. ' +
            'Run `muhaven-broker logout` if you want to clean it up.',
        };
      }
    }
  } catch (err) {
    const isMalformed = err instanceof KeystoreError && err.code === 'malformed_record';
    return {
      keystore: new FileKeystore(filePath),
      fallbackReason: isMalformed
        ? `OS keychain held a malformed JWT record — falling back to file. ${asMessage(err)}`
        : `OS keychain probe failed: ${asMessage(err)}`,
    };
  }
  return { keystore: new OsKeystore(mockEntry), fallbackReason: null };
}

// `openKeystoreForTest` is exported at module scope above — tests should
// import it directly. `__INTERNAL_FOR_TESTS` only exposes class symbols
// that are otherwise un-exported, so callers can construct mocks at the
// class level when the public API isn't enough.
export const __INTERNAL_FOR_TESTS = { FileKeystore, OsKeystore, parseRecord };
