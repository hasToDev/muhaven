/**
 * Contract address registry per network.
 * Active network selected by VITE_CHAIN_ID env var.
 *
 * Any VITE_*_ADDRESS env var overrides the baked-in default for its slot,
 * which is how staging builds (`bun run build:stage` → .env.stage) point
 * at a separate contract deployment without touching this file.
 *
 * Wave 3.5 contracts use the `v35` namespace. They are populated from env
 * vars once the Phase 8 cutover deploys them. Until then, zero-address
 * defaults signal "not deployed" to UI consumers — they render fallback
 * states rather than crash.
 */

const ZERO = '0x0000000000000000000000000000000000000000' as `0x${string}`

export interface ContractAddresses {
  // Wave 3 (shipped + deployed)
  muHavenToken: `0x${string}`
  muHavenVault: `0x${string}`
  investorRegistry: `0x${string}`
  yieldDistributor: `0x${string}`
  kycAdapter: `0x${string}`
  riskParams: `0x${string}`
  yieldGate: `0x${string}`
  muhavenEscrow: `0x${string}`
  // External (ReineiraOS) — shared across envs
  usdc: `0x${string}`
  pusdc: `0x${string}`
}

export interface V35Addresses {
  // Wave 3.5 — populated via env overrides once deployed (Phase 8)
  subscription: `0x${string}`
  tokenRegistry: `0x${string}`
  identityRegistry: `0x${string}`
  modularCompliance: `0x${string}`
  oracle: `0x${string}`
  /**
   * Phase 7.5 — `MuHavenStable` confidential-USDC wrapper. Replaces every
   * Wave 3.5 use of legacy PUSDC per `MHUSD_WRAPPER_PLAN.md` + ADR-041.
   * Zero address signals "wrapper not deployed" — UI consumers fall back
   * to legacy PUSDC reads in that mode.
   */
  muHavenStable: `0x${string}`
  /** Per-token treasury — env override is a JSON `{ "0xToken": "0xTreasury" }` map. */
  treasuries: Record<string, `0x${string}`>
  /** Per-token queue — same JSON-map shape as treasuries. */
  queues: Record<string, `0x${string}`>
  /** Per-token yield snapshot — same JSON-map shape. */
  yieldSnapshots: Record<string, `0x${string}`>
  /**
   * Singleton YieldSnapshot proxy. Wave 3.5 deploys ONE snapshot proxy
   * across every RWA token (per the staging env example: "every entry in
   * VITE_YIELD_SNAPSHOTS_JSON points to the same proxy"). Wizard-deployed
   * tokens (F2 self-serve onboarding) don't add entries to the per-token
   * map at runtime, so consumers must fall back to this singleton when
   * the per-token lookup misses. Set via VITE_YIELD_SNAPSHOT_ADDRESS.
   * Zero-address signals "no fallback configured" — same as a missing
   * per-token entry.
   */
  yieldSnapshot: `0x${string}`
}

const arbSepolia: ContractAddresses = {
  muHavenToken: '0xF95c9aA19e974e4cA0778AAdb76580423eEEeb03',
  muHavenVault: '0xF445898f1af1DFde88E26c75C4d35c9025C5C631',
  investorRegistry: '0x9e19cFC63661AF1624ba16392dc02134F91d36f6',
  yieldDistributor: '0xD403252436e41EFd81D76eB9223485cB66cb1638',
  kycAdapter: '0x0aF7003E645b3f8028dac59556aa0Cf0AeA21851',
  riskParams: '0x7F287982232De3C78c1958Aa11f3D9826B445604',
  yieldGate: '0x2cBAa54E5Ce4ED6D68722e35E18eba77B1c11964',
  muhavenEscrow: '0xb18ca2122b31Df9Aaef8226f6218Bd93B852F40A',
  usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
  pusdc: '0x6b6e6479b8b3237933c3ab9d8be969862d4ed89f',
}

const addressMap: Record<string, ContractAddresses> = {
  '421614': arbSepolia,
}

const chainId = import.meta.env.VITE_CHAIN_ID || '421614'
const base: ContractAddresses = addressMap[chainId] ?? arbSepolia

const pick = (override: string | undefined, fallback: `0x${string}`): `0x${string}` =>
  override && /^0x[0-9a-fA-F]{40}$/.test(override) ? (override as `0x${string}`) : fallback

export const addresses: ContractAddresses = {
  muHavenToken: pick(import.meta.env.VITE_MUHAVEN_TOKEN_ADDRESS, base.muHavenToken),
  muHavenVault: pick(import.meta.env.VITE_MUHAVEN_VAULT_ADDRESS, base.muHavenVault),
  investorRegistry: pick(import.meta.env.VITE_INVESTOR_REGISTRY_ADDRESS, base.investorRegistry),
  yieldDistributor: pick(import.meta.env.VITE_YIELD_DISTRIBUTOR_ADDRESS, base.yieldDistributor),
  kycAdapter: pick(import.meta.env.VITE_KYC_ADAPTER_ADDRESS, base.kycAdapter),
  riskParams: pick(import.meta.env.VITE_RISK_PARAMS_ADDRESS, base.riskParams),
  yieldGate: pick(import.meta.env.VITE_YIELD_GATE_ADDRESS, base.yieldGate),
  muhavenEscrow: pick(import.meta.env.VITE_MUHAVEN_ESCROW_ADDRESS, base.muhavenEscrow),
  usdc: base.usdc,
  pusdc: base.pusdc,
}

/**
 * Parse a per-token JSON map env override like
 * `{"0xToken1": "0xTreasury1", "0xToken2": "0xTreasury2"}`. Invalid JSON or
 * malformed entries fall back to an empty map rather than throwing — the UI
 * still renders a "contract not available" state for unconfigured tokens.
 */
function parsePerTokenMap(raw: string | undefined): Record<string, `0x${string}`> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, `0x${string}`> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v !== 'string') continue
      if (!/^0x[0-9a-fA-F]{40}$/.test(k)) continue
      if (!/^0x[0-9a-fA-F]{40}$/.test(v)) continue
      out[k.toLowerCase()] = v as `0x${string}`
    }
    return out
  } catch {
    return {}
  }
}

export const v35Addresses: V35Addresses = {
  subscription: pick(import.meta.env.VITE_SUBSCRIPTION_ADDRESS, ZERO),
  tokenRegistry: pick(import.meta.env.VITE_TOKEN_REGISTRY_ADDRESS, ZERO),
  identityRegistry: pick(import.meta.env.VITE_IDENTITY_REGISTRY_ADDRESS, ZERO),
  modularCompliance: pick(import.meta.env.VITE_MODULAR_COMPLIANCE_ADDRESS, ZERO),
  oracle: pick(import.meta.env.VITE_ORACLE_ADDRESS, ZERO),
  muHavenStable: pick(import.meta.env.VITE_MUHAVEN_STABLE_ADDRESS, ZERO),
  treasuries: parsePerTokenMap(import.meta.env.VITE_TREASURIES_JSON),
  queues: parsePerTokenMap(import.meta.env.VITE_QUEUES_JSON),
  yieldSnapshots: parsePerTokenMap(import.meta.env.VITE_YIELD_SNAPSHOTS_JSON),
  yieldSnapshot: pick(import.meta.env.VITE_YIELD_SNAPSHOT_ADDRESS, ZERO),
}

export function isZeroAddress(addr: `0x${string}`): boolean {
  return addr.toLowerCase() === ZERO
}

export function getTreasury(token: `0x${string}`): `0x${string}` | null {
  return v35Addresses.treasuries[token.toLowerCase()] ?? null
}

export function getQueue(token: `0x${string}`): `0x${string}` | null {
  return v35Addresses.queues[token.toLowerCase()] ?? null
}

// ── Runtime per-token YieldSnapshot map ─────────────────────────────
//
// Wave 5+ per-token YieldSnapshot proxy binding (2026-05-23). The F2
// wizard deploys a fresh `YieldSnapshot` proxy per RWA token and the
// address lands in `rwa_tokens.yield_snapshot_address`, surfaced to
// the frontend through `TokenResponseDto.yield_snapshot_address`.
// Token stores (issuer-tokens, marketplace, portfolio — anywhere a
// `/v1/tokens` or `/v1/issuer/tokens` response is parsed) call
// `registerYieldSnapshot(addr, snapshot)` on load so the runtime map
// is populated before any consumer (SnapshotService, runner) resolves.
//
// Why a runtime map instead of replacing the env-var maps entirely:
// the env-var maps stay as a build-time fallback for environments
// where the backend can't be reached at boot (smoke tests, offline
// dev, indexer-only scripts), and the legacy seed rows (which
// predate per-token snapshots) carry a `null` `yield_snapshot_address`
// — those resolve through the singleton fallback chain unchanged.
const dynamicYieldSnapshots: Record<string, `0x${string}`> = {}

/**
 * Register a per-token YieldSnapshot proxy address from a backend
 * response. Token-store consumers call this in their `load()` hooks
 * before any UI consumer reads `getYieldSnapshot(token)`. Silent
 * no-op for null/empty/zero-address values so callers don't have to
 * guard around legacy rows. Always lower-cases the token key so the
 * runtime + env-var maps share the same lookup convention.
 */
export function registerYieldSnapshot(
  token: `0x${string}` | string | null | undefined,
  snapshot: `0x${string}` | string | null | undefined,
): void {
  if (!token || !snapshot) return
  if (typeof token !== 'string' || typeof snapshot !== 'string') return
  // Pick B round-1 SE MED (2026-05-23): symmetric address validation
  // on BOTH ends. The map key must be a real hex address — a malicious
  // or buggy backend response with `token = "<script>"` or an
  // arbitrary garbage string would otherwise poison the map. Mirrors
  // the snapshot regex.
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) return
  if (!/^0x[0-9a-fA-F]{40}$/.test(snapshot)) return
  // Round-2 CR N-2 (2026-05-23): block zero-address on both ends, not
  // just the snapshot. A zero-address token key would silently land in
  // the map — untriggered today (backend never returns 0x000…0000) but
  // symmetric to the snapshot check.
  if (token.toLowerCase() === ZERO) return
  if (snapshot === ZERO) return
  dynamicYieldSnapshots[token.toLowerCase()] = snapshot as `0x${string}`
}

/**
 * Clear the runtime per-token snapshot map. Auth-boundary teardown
 * hook for `useAuth.tearDownUserStores`: a fresh login should not
 * carry the prior session's snapshot-address registrations into the
 * new session (especially if the new user's issuer onboarding rotates
 * a snapshot proxy between sessions).
 */
export function clearYieldSnapshotRegistry(): void {
  for (const k of Object.keys(dynamicYieldSnapshots)) {
    delete dynamicYieldSnapshots[k]
  }
}

export function getYieldSnapshot(token: `0x${string}`): `0x${string}` | null {
  // Resolution order (Wave 5+):
  //   1. Runtime registration from backend `TokenResponseDto` — the
  //      authoritative per-token address as of the wizard's
  //      `deploy_yield_snapshot` step.
  //   2. Build-time env-var per-token map (VITE_YIELD_SNAPSHOTS_JSON) —
  //      legacy fallback for tokens deployed before per-token snapshots.
  //   3. Singleton (VITE_YIELD_SNAPSHOT_ADDRESS) — covers legacy seed
  //      rows where the env-var map has no entry.
  const runtime = dynamicYieldSnapshots[token.toLowerCase()]
  if (runtime && !isZeroAddress(runtime)) return runtime
  const perToken = v35Addresses.yieldSnapshots[token.toLowerCase()]
  if (perToken && !isZeroAddress(perToken)) return perToken
  if (!isZeroAddress(v35Addresses.yieldSnapshot)) return v35Addresses.yieldSnapshot
  return null
}
