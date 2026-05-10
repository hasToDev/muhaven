/**
 * Keystore probe regression tests (H-3, MCP_PUBLISH_READINESS.md §2.3).
 *
 * The OS-keychain probe in `openKeystore()` previously called
 * `getPassword()` and ignored the result. A corrupted record (wrong-
 * version JSON, partial write from a prior broker, or a value some
 * other tool stored under the same KEYRING_SERVICE+ACCOUNT pair) would
 * pass that probe and surface only at the first MCP call as
 * `keystore_unavailable`. The fix round-trip-parses the probe value
 * and falls back to the file backend with a logged reason on any
 * malformed shape.
 *
 * These tests use `openKeystoreForTest` (exposed via
 * `__INTERNAL_FOR_TESTS`) to inject a fake Entry — bypassing the
 * dynamic `@napi-rs/keyring` import and keeping the test platform-
 * agnostic.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openKeystoreForTest } from '../src/broker/keystore.js';

const tempDirs: string[] = [];

function tempFilePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muhaven-keystore-test-'));
  tempDirs.push(dir);
  return join(dir, 'jwt');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
});

describe('openKeystore probe — H-3 regression', () => {
  it('falls back to file backend when OS keychain holds malformed JSON', async () => {
    const fakeEntry = {
      getPassword: () => '{not-valid-json',
      setPassword: () => undefined,
      deletePassword: () => undefined,
    };
    const result = await openKeystoreForTest(fakeEntry, { filePath: tempFilePath() });
    expect(result.keystore.backend).toBe('file');
    expect(result.fallbackReason).toMatch(/malformed/i);
  });

  it('falls back to file backend when OS keychain holds JSON-but-wrong-shape', async () => {
    const fakeEntry = {
      getPassword: () => '{"unrelated":"data"}',
      setPassword: () => undefined,
      deletePassword: () => undefined,
    };
    const result = await openKeystoreForTest(fakeEntry, { filePath: tempFilePath() });
    expect(result.keystore.backend).toBe('file');
    expect(result.fallbackReason).toMatch(/did not contain a recognizable JWT/i);
  });

  it('keeps OS backend when probe value is empty (fresh install)', async () => {
    const fakeEntry = {
      getPassword: () => '',
      setPassword: () => undefined,
      deletePassword: () => undefined,
    };
    const result = await openKeystoreForTest(fakeEntry, { filePath: tempFilePath() });
    expect(result.keystore.backend).toBe('os');
    expect(result.fallbackReason).toBeNull();
  });

  it('keeps OS backend when probe value is a valid record', async () => {
    const fakeEntry = {
      getPassword: () =>
        JSON.stringify({ jwt: 'eyJhbGciOi.payload.sig', expiresAtSec: null, storedAtSec: 0 }),
      setPassword: () => undefined,
      deletePassword: () => undefined,
    };
    const result = await openKeystoreForTest(fakeEntry, { filePath: tempFilePath() });
    expect(result.keystore.backend).toBe('os');
    expect(result.fallbackReason).toBeNull();
  });

  it('falls back to file backend when getPassword throws (Secret Service down)', async () => {
    const fakeEntry = {
      getPassword: () => {
        throw new Error('secret service: connection refused');
      },
      setPassword: () => undefined,
      deletePassword: () => undefined,
    };
    const result = await openKeystoreForTest(fakeEntry, { filePath: tempFilePath() });
    expect(result.keystore.backend).toBe('file');
    expect(result.fallbackReason).toMatch(/probe failed/i);
    expect(result.fallbackReason).toMatch(/secret service/i);
  });
});
