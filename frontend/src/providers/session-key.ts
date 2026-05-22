/**
 * Session-key lifecycle helpers.
 *
 * Stores per-smart-account session data in `sessionStorage` so it is cleared
 * on tab close (blast-radius safety) but survives page reloads within the
 * same tab. Keyed by the smart account address + the active permission
 * fingerprint so that any change to `SESSION_PERMISSIONS` in source
 * automatically invalidates older cached records (the on-chain CallPolicy
 * is baked into the validator install — without an invalidation key, a
 * cached session whose policy is missing a freshly-added permission
 * would AA23-revert silently and bounce to the passkey kernel forever).
 *
 * Duration is configurable via `VITE_SESSION_KEY_DURATION_SEC` (default 3600).
 */

import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import type { Hex } from 'viem'

const STORAGE_PREFIX = 'muhaven-session:'
const DEFAULT_DURATION_SEC = 3600

/**
 * Permission fingerprint set by `zerodev.provider.ts` once at module load.
 * Used as part of the storage key so cached records bound to a previous
 * policy don't survive a code change. Module load order ensures this is
 * set before any session-key UI flow runs.
 */
let permsVersion: string | null = null

export function setSessionPermsVersion(version: string): void {
  permsVersion = version
}

export interface SessionKeyRecord {
  privateKey: Hex
  smartAccountAddress: `0x${string}`
  expiresAt: number
  /** Populated after the first successful UserOp caches the enableSig. */
  serializedAccount?: string
}

function storageKey(smartAccountAddress: string): string {
  if (!permsVersion) {
    throw new Error(
      'session-key: permission fingerprint not set — '
      + 'call setSessionPermsVersion before any IO',
    )
  }
  return `${STORAGE_PREFIX}${permsVersion}:${smartAccountAddress.toLowerCase()}`
}

function readDurationSec(): number {
  const raw = import.meta.env.VITE_SESSION_KEY_DURATION_SEC
  if (typeof raw === 'string') {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return DEFAULT_DURATION_SEC
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Generate an in-memory session-key record + signer.
 *
 * `ttlSecOverride` is the Wave 5 Path D Pickup A carrier: Scoped tier mints
 * supply a user-set TTL up to 24h, while the legacy in-tab path passes
 * `undefined` and falls back to `VITE_SESSION_KEY_DURATION_SEC` (default 1h).
 * The override flows through to `record.expiresAt`, which the caller passes
 * into `toTimestampPolicy({validUntil})` on the PermissionValidator.
 */
export function generateSessionRecord(
  smartAccountAddress: `0x${string}`,
  ttlSecOverride?: number,
): { record: SessionKeyRecord; signer: PrivateKeyAccount } {
  const privateKey = generatePrivateKey()
  const signer = privateKeyToAccount(privateKey)
  const ttl = ttlSecOverride !== undefined && ttlSecOverride > 0
    ? ttlSecOverride
    : readDurationSec()
  const record: SessionKeyRecord = {
    privateKey,
    smartAccountAddress,
    expiresAt: nowSec() + ttl,
  }
  return { record, signer }
}

export function signerFromRecord(record: SessionKeyRecord): PrivateKeyAccount {
  return privateKeyToAccount(record.privateKey)
}

export function saveSessionRecord(record: SessionKeyRecord): void {
  try {
    sessionStorage.setItem(storageKey(record.smartAccountAddress), JSON.stringify(record))
  } catch (e) {
    console.warn('[session-key] sessionStorage write failed', e)
  }
}

export function loadSessionRecord(smartAccountAddress: string): SessionKeyRecord | null {
  try {
    const raw = sessionStorage.getItem(storageKey(smartAccountAddress))
    if (!raw) return null
    const parsed = JSON.parse(raw) as SessionKeyRecord
    if (!isRecordValid(parsed)) {
      clearSessionRecord(smartAccountAddress)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function clearSessionRecord(smartAccountAddress: string): void {
  try {
    sessionStorage.removeItem(storageKey(smartAccountAddress))
  } catch {
    /* sessionStorage may be disabled in private mode — ignore */
  }
}

export function isRecordValid(record: SessionKeyRecord | null | undefined): record is SessionKeyRecord {
  if (!record) return false
  if (typeof record.privateKey !== 'string' || !record.privateKey.startsWith('0x')) return false
  if (typeof record.expiresAt !== 'number') return false
  return record.expiresAt > nowSec()
}

export function expirySecondsRemaining(record: SessionKeyRecord): number {
  return Math.max(0, record.expiresAt - nowSec())
}
