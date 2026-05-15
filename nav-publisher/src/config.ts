/**
 * NAV publisher configuration — pure env-var read.
 *
 * Validation deferred to first call; throws on missing required keys
 * so a misconfigured deploy fails loudly at startup instead of silently
 * skipping every cycle.
 */

export type PublishStrategy = 'refresh-only' | 'skip';

export interface Config {
  port: number;
  databaseUrl: string;
  publishIntervalMs: number;
  dbLivenessMs: number;
  defaultStrategy: PublishStrategy;
  /** Lookup is normalised lower-case for both symbol and 0x address keys. */
  strategies: Map<string, PublishStrategy>;
  chainId: number;
  rpcUrl: string;
  oracleAddress: `0x${string}`;
  /**
   * `TokenRegistry` proxy address. Required since 2026-05-17 (Design A).
   * `nav-publisher` enumerates active tokens from this registry at startup
   * unless `NAV_PUBLISH_TOKENS` overrides explicitly. Static env-based
   * roster missed apply-issuer-onboarded tokens; on-chain enumeration
   * picks them up automatically on next container restart.
   */
  tokenRegistryAddress: `0x${string}`;
  /**
   * Token roster. After startup, this is either the explicit
   * `NAV_PUBLISH_TOKENS` override (when set) or the result of enumerating
   * active tokens from `TokenRegistry`. NOTE: this field is MUTATED
   * once during `startup()` in `index.ts` — see `applyDiscoveredTokens`
   * below. Callers that grab the array reference after startup see the
   * resolved set; callers that grabbed it before startup would still see
   * the empty placeholder. Since the only callers are scheduler-driven
   * and run after startup completes, this is safe.
   */
  tokens: `0x${string}`[];
  /** address (lower-case) → symbol — purely for log readability. */
  symbols: Map<string, string>;
  publisherPrivateKey: `0x${string}`;
  txRetries: number;
  txRetryDelayMs: number;
  txConfirmTimeoutMs: number;
}

let cached: Config | null = null;

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function parseAddr(name: string, value: string): `0x${string}` {
  if (!ADDR_RE.test(value)) {
    throw new Error(`${name} is not a valid 0x address: ${value}`);
  }
  return value.toLowerCase() as `0x${string}`;
}

function parseStrategy(s: string): PublishStrategy {
  const v = s.trim().toLowerCase();
  if (v === 'refresh-only' || v === 'skip') return v;
  throw new Error(`unsupported publish strategy: "${s}" (expected refresh-only | skip)`);
}

/**
 * Parse `KEY=value` pairs separated by commas. Whitespace around tokens
 * and `=` is tolerated. Empty input returns an empty map.
 */
function parsePairs(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw) return out;
  for (const piece of raw.split(',')) {
    const trimmed = piece.trim();
    if (trimmed === '') continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      throw new Error(`expected KEY=value but got "${trimmed}"`);
    }
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    const value = trimmed.slice(eq + 1).trim();
    if (key === '' || value === '') {
      throw new Error(`empty key or value in pair "${trimmed}"`);
    }
    out.set(key, value);
  }
  return out;
}

export function getConfig(): Config {
  if (cached) return cached;

  const port = Number(process.env.PORT) || 3003;
  const databaseUrl = requireEnv('DATABASE_URL');
  const publishIntervalMs = Number(process.env.NAV_PUBLISH_INTERVAL_MS) || 32_400_000; // 9h
  const dbLivenessMs = Number(process.env.NAV_DB_LIVENESS_MS ?? 4 * publishIntervalMs);
  const defaultStrategy = parseStrategy(
    process.env.NAV_PUBLISH_DEFAULT_STRATEGY ?? 'refresh-only',
  );

  const strategyPairs = parsePairs(process.env.NAV_PUBLISH_STRATEGIES);
  const strategies = new Map<string, PublishStrategy>();
  for (const [k, v] of strategyPairs) strategies.set(k, parseStrategy(v));

  const chainId = Number(process.env.CHAIN_ID) || 421614;
  const rpcUrl = process.env.ARB_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc';
  const oracleAddress = parseAddr('ORACLE_ADDRESS', requireEnv('ORACLE_ADDRESS'));

  // NAV_PUBLISH_TOKENS is now an OVERRIDE (2026-05-17 Design A). When
  // unset/empty, the publisher enumerates active tokens from
  // TokenRegistry at startup. Override is useful for:
  //   - testing against a subset of tokens
  //   - sentinel exclusion (deliberately skip a problematic token while
  //     keeping the rest of the roster live)
  const tokensRaw = (process.env.NAV_PUBLISH_TOKENS ?? '').trim();
  const tokens: `0x${string}`[] = tokensRaw === ''
    ? []
    : tokensRaw.split(',').map((t) => parseAddr('NAV_PUBLISH_TOKENS', t.trim()));

  // TOKEN_REGISTRY_ADDRESS — required only when NAV_PUBLISH_TOKENS is
  // empty (the new default mode). When the operator has set
  // NAV_PUBLISH_TOKENS (existing prod .env state), the registry isn't
  // consulted so we don't force them to touch their env file. After the
  // first onboarding past 2026-05-17 they should drop the override and
  // set TOKEN_REGISTRY_ADDRESS instead.
  const tokenRegistryRaw = (process.env.TOKEN_REGISTRY_ADDRESS ?? '').trim();
  if (tokens.length === 0 && tokenRegistryRaw === '') {
    throw new Error(
      'Either NAV_PUBLISH_TOKENS or TOKEN_REGISTRY_ADDRESS must be set. ' +
        'Recommended (Design A 2026-05-17): set TOKEN_REGISTRY_ADDRESS and leave ' +
        'NAV_PUBLISH_TOKENS unset so the publisher enumerates active tokens from chain.',
    );
  }
  // Zero address is a structural placeholder when the operator only set
  // NAV_PUBLISH_TOKENS and isn't using on-chain enumeration. The
  // `discoverActiveTokens` path is gated on `tokens.length === 0` so
  // this address is never read in override mode.
  const tokenRegistryAddress: `0x${string}` =
    tokenRegistryRaw === ''
      ? '0x0000000000000000000000000000000000000000'
      : parseAddr('TOKEN_REGISTRY_ADDRESS', tokenRegistryRaw);

  const symbolPairs = parsePairs(process.env.NAV_PUBLISH_TOKEN_SYMBOLS);
  const symbols = new Map<string, string>();
  for (const [symbolKey, addrValue] of symbolPairs) {
    const addr = parseAddr('NAV_PUBLISH_TOKEN_SYMBOLS', addrValue);
    // Store the canonical symbol-cased name; key by address (lower-case).
    symbols.set(addr, symbolKey.toUpperCase());
  }

  const publisherPrivateKeyRaw = requireEnv('NAV_PUBLISHER_PRIVATE_KEY');
  const pk = publisherPrivateKeyRaw.startsWith('0x')
    ? publisherPrivateKeyRaw
    : `0x${publisherPrivateKeyRaw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error('NAV_PUBLISHER_PRIVATE_KEY must be a 32-byte hex string');
  }

  const txRetries = Number(process.env.NAV_PUBLISH_TX_RETRIES) || 3;
  const txRetryDelayMs = Number(process.env.NAV_PUBLISH_TX_RETRY_DELAY_MS) || 2000;
  const txConfirmTimeoutMs = Number(process.env.NAV_PUBLISH_TX_CONFIRM_TIMEOUT_MS) || 120_000;

  cached = {
    port,
    databaseUrl,
    publishIntervalMs,
    dbLivenessMs,
    defaultStrategy,
    strategies,
    chainId,
    rpcUrl,
    oracleAddress,
    tokenRegistryAddress,
    tokens,
    symbols,
    publisherPrivateKey: pk as `0x${string}`,
    txRetries,
    txRetryDelayMs,
    txConfirmTimeoutMs,
  };

  return cached;
}

/**
 * Apply tokens discovered from on-chain TokenRegistry. Called once by
 * `startup()` in `index.ts` after `getChain()` succeeds.
 *
 * This MUTATES `cached.tokens` (and merges into `cached.symbols`) so
 * scheduler.ts + publisher.ts pick up the discovered set on their first
 * cycle. Yes, mutating cached state is icky — but contained to a single
 * lifecycle point + the alternative (refactor every call-site to await
 * an async tokens-getter) is much wider blast radius.
 *
 * Idempotent: a second call with the same addresses is a no-op.
 * Override-aware: if `NAV_PUBLISH_TOKENS` was set (config.tokens non-empty
 * at boot), this becomes a no-op so the operator's explicit override
 * wins.
 */
export function applyDiscoveredTokens(
  discovered: { address: `0x${string}`; symbol?: string }[],
): { applied: number; skippedOverride: boolean } {
  if (!cached) {
    throw new Error('applyDiscoveredTokens called before getConfig()');
  }
  if (cached.tokens.length > 0) {
    // NAV_PUBLISH_TOKENS override is in effect — operator-supplied
    // roster takes precedence.
    return { applied: 0, skippedOverride: true };
  }
  for (const t of discovered) {
    cached.tokens.push(t.address.toLowerCase() as `0x${string}`);
    if (t.symbol && t.symbol !== '') {
      cached.symbols.set(t.address.toLowerCase(), t.symbol);
    }
  }
  return { applied: discovered.length, skippedOverride: false };
}

/**
 * Render a token address as `SYMBOL` if known, otherwise as `0xabcd…ef01`.
 */
export function labelToken(addr: string, symbols: Map<string, string>): string {
  const lower = addr.toLowerCase();
  const symbol = symbols.get(lower);
  if (symbol) return symbol;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
