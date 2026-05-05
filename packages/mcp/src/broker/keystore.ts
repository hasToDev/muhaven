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
    // probe read; ignore content
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (entry as any).getPassword();
  } catch (err) {
    return {
      keystore: new FileKeystore(filePath),
      fallbackReason: `OS keychain probe failed: ${asMessage(err)}`,
    };
  }

  return { keystore: new OsKeystore(entry), fallbackReason: null };
}

export const __INTERNAL_FOR_TESTS = { FileKeystore, OsKeystore, parseRecord };
