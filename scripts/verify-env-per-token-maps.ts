/**
 * Verify that frontend/.env (or another .env passed via --env) per-token
 * JSON maps line up with the deployed contracts in
 * deployments/arb-sepolia-v2.json.
 *
 * Catches three drift classes that cause silent UX bugs:
 *
 *   1. Token key has no on-chain twin. Session-key permissions in
 *      `zerodev.provider.ts` iterate `Object.keys(v35Addresses.treasuries)`
 *      and silently scope `refreshDecryptGrant` on a phantom address.
 *   2. Treasury / queue value doesn't match the deployed slot. The buy
 *      flow goes through Subscription.purchase (on-chain mapping), so a
 *      mismatch lands as a session-key permission for the wrong contract
 *      — invisible until decrypt fails.
 *   3. YieldSnapshot value diverges from the singleton (`VITE_YIELD_SNAPSHOT_ADDRESS`).
 *      Wave 3.5 deploys ONE shared YieldSnapshot proxy across every token;
 *      a per-token entry pointing elsewhere defeats the fallback chain.
 *
 * The check is symmetric on the value side (treasury/queue values must
 * match deployment) but lenient on key completeness — keys may legitimately
 * lag deployments during a phased rollout. A warning surfaces, not a fail.
 *
 * Usage:
 *   pnpm verify:env-per-token-maps                          (defaults: frontend/.env)
 *   pnpm verify:env-per-token-maps --env frontend/.env.stage
 *   pnpm verify:env-per-token-maps --deployments deployments/arb-sepolia.staging-v2.json
 *
 * Exit codes: 0 = clean, 1 = drift detected.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

interface DeploymentTokenRecord {
  symbol: string
  status?: string
  contracts: {
    MuHavenToken: { proxy: string }
    RedemptionQueue: { proxy: string }
    MuHavenTreasury: { proxy: string }
  }
}

interface DeploymentsFile {
  tokens: Record<string, DeploymentTokenRecord>
}

interface EnvSlice {
  treasuries: Record<string, string>
  queues: Record<string, string>
  yieldSnapshots: Record<string, string>
  yieldSnapshotSingleton: string | null
}

function parseArgs(argv: readonly string[]): { envPath: string; deploymentsPath: string } {
  let envPath = 'frontend/.env'
  let deploymentsPath = 'deployments/arb-sepolia-v2.json'
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--env' && argv[i + 1]) { envPath = argv[i + 1]!; i += 1 }
    else if (arg === '--deployments' && argv[i + 1]) { deploymentsPath = argv[i + 1]!; i += 1 }
  }
  return { envPath, deploymentsPath }
}

function readEnvSlice(path: string): EnvSlice {
  const raw = readFileSync(path, 'utf8')
  const map: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trimStart()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    map[key] = value
  }
  return {
    treasuries: parseJsonMap(map.VITE_TREASURIES_JSON, 'VITE_TREASURIES_JSON'),
    queues: parseJsonMap(map.VITE_QUEUES_JSON, 'VITE_QUEUES_JSON'),
    yieldSnapshots: parseJsonMap(map.VITE_YIELD_SNAPSHOTS_JSON, 'VITE_YIELD_SNAPSHOTS_JSON'),
    yieldSnapshotSingleton: ADDRESS_RE.test(map.VITE_YIELD_SNAPSHOT_ADDRESS ?? '')
      ? (map.VITE_YIELD_SNAPSHOT_ADDRESS ?? null)
      : null,
  }
}

function parseJsonMap(raw: string | undefined, name: string): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${name} is not a JSON object`)
    }
    return parsed as Record<string, string>
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`${name} failed to parse: ${msg}`)
  }
}

interface Drift {
  level: 'error' | 'warn'
  message: string
}

function check(env: EnvSlice, deployments: DeploymentsFile): Drift[] {
  const drift: Drift[] = []

  // Build expected token→treasury, token→queue tables from deployments.
  const expectedTreasury = new Map<string, string>()
  const expectedQueue = new Map<string, string>()
  const expectedTokens = new Set<string>()
  for (const record of Object.values(deployments.tokens)) {
    const token = record.contracts.MuHavenToken.proxy.toLowerCase()
    expectedTokens.add(token)
    expectedTreasury.set(token, record.contracts.MuHavenTreasury.proxy)
    expectedQueue.set(token, record.contracts.RedemptionQueue.proxy)
  }

  // Per-map drift detection.
  const checkValueMap = (
    mapName: string,
    map: Record<string, string>,
    expected: Map<string, string>,
  ) => {
    for (const [rawKey, rawValue] of Object.entries(map)) {
      const key = rawKey.toLowerCase()
      if (!ADDRESS_RE.test(rawKey)) {
        drift.push({ level: 'error', message: `${mapName}: invalid key "${rawKey}" — not a 40-char hex address` })
        continue
      }
      if (!ADDRESS_RE.test(rawValue)) {
        drift.push({ level: 'error', message: `${mapName}[${rawKey}]: invalid value "${rawValue}" — not a 40-char hex address` })
        continue
      }
      if (!expectedTokens.has(key)) {
        drift.push({ level: 'error', message: `${mapName}[${rawKey}]: key does not match any deployed MuHavenToken.proxy` })
        continue
      }
      const expectedValue = expected.get(key)
      if (expectedValue && expectedValue.toLowerCase() !== rawValue.toLowerCase()) {
        drift.push({
          level: 'error',
          message: `${mapName}[${rawKey}]: value ${rawValue} does not match deployed slot ${expectedValue}`,
        })
      }
    }
    // Completeness warning — every deployed (active) token should map.
    // `expectedTokens` values are already lowercased; build the map's
    // lowercase-key set once and probe it directly.
    const mapKeysLower = new Set(Object.keys(map).map((k) => k.toLowerCase()))
    for (const token of expectedTokens) {
      if (!mapKeysLower.has(token)) {
        drift.push({ level: 'warn', message: `${mapName}: deployment ${token} has no entry (session-key permissions will fall back to passkey)` })
      }
    }
  }

  checkValueMap('VITE_TREASURIES_JSON', env.treasuries, expectedTreasury)
  checkValueMap('VITE_QUEUES_JSON', env.queues, expectedQueue)

  // YieldSnapshot map: every value must equal the singleton (Wave 3.5
  // convention — one shared proxy across every token). Per-token entries
  // pointing elsewhere defeat the fallback chain in `getYieldSnapshot`.
  for (const [rawKey, rawValue] of Object.entries(env.yieldSnapshots)) {
    const key = rawKey.toLowerCase()
    if (!ADDRESS_RE.test(rawKey)) {
      drift.push({ level: 'error', message: `VITE_YIELD_SNAPSHOTS_JSON: invalid key "${rawKey}"` })
      continue
    }
    if (!ADDRESS_RE.test(rawValue)) {
      drift.push({ level: 'error', message: `VITE_YIELD_SNAPSHOTS_JSON[${rawKey}]: invalid value "${rawValue}"` })
      continue
    }
    if (!expectedTokens.has(key)) {
      drift.push({ level: 'error', message: `VITE_YIELD_SNAPSHOTS_JSON[${rawKey}]: key does not match any deployed MuHavenToken.proxy` })
      continue
    }
    if (env.yieldSnapshotSingleton && rawValue.toLowerCase() !== env.yieldSnapshotSingleton.toLowerCase()) {
      drift.push({
        level: 'error',
        message: `VITE_YIELD_SNAPSHOTS_JSON[${rawKey}]: value ${rawValue} diverges from VITE_YIELD_SNAPSHOT_ADDRESS singleton ${env.yieldSnapshotSingleton}`,
      })
    }
  }

  return drift
}

function main(): void {
  const { envPath, deploymentsPath } = parseArgs(process.argv.slice(2))
  const envAbs = resolve(envPath)
  const deploymentsAbs = resolve(deploymentsPath)

  const env = readEnvSlice(envAbs)
  const deployments = JSON.parse(readFileSync(deploymentsAbs, 'utf8')) as DeploymentsFile

  const drift = check(env, deployments)

  const errors = drift.filter((d) => d.level === 'error')
  const warnings = drift.filter((d) => d.level === 'warn')

  console.log(`Verifying ${envPath} against ${deploymentsPath}`)
  console.log(`Token deployments scanned: ${Object.keys(deployments.tokens).length}`)
  console.log(`Map sizes: treasuries=${Object.keys(env.treasuries).length} queues=${Object.keys(env.queues).length} yieldSnapshots=${Object.keys(env.yieldSnapshots).length}`)
  console.log('')

  for (const w of warnings) console.warn(`  WARN  ${w.message}`)
  for (const e of errors) console.error(`  FAIL  ${e.message}`)

  if (errors.length === 0 && warnings.length === 0) {
    console.log('OK — all maps in sync with deployment.')
  } else if (errors.length === 0) {
    console.log(`\n${warnings.length} warning(s), no errors.`)
  } else {
    console.error(`\n${errors.length} error(s), ${warnings.length} warning(s). Fix the .env before building.`)
    process.exit(1)
  }
}

main()
