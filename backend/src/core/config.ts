import { z } from 'zod';

const EnvSchema = z.object({
  // Database
  DB_PROVIDER: z.enum(['memory', 'postgres']).default('memory'),
  DATABASE_URL: z.string().optional(),

  // Auth
  JWT_SECRET: z.string().min(1),
  JWT_ISSUER: z.string().default('muhaven.xyz'),
  ACCESS_TOKEN_TTL: z.coerce.number().default(3600),
  REFRESH_TOKEN_TTL: z.coerce.number().default(2592000),

  // Chain
  CHAIN_ID: z.coerce.number().default(421614),
  RPC_URL: z.string().optional(),

  // CORS
  ALLOWED_ORIGINS: z.string().default('http://localhost:7778'),

  // Logging + Server
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: z.coerce.number().default(3000),

  // FHE Worker
  FHE_WORKER_URL: z.string().default('http://localhost:3001'),

  // ZeroDev (passkey smart accounts)
  ZERODEV_BUNDLER_URL: z.string().optional(),
  ZERODEV_PASSKEY_SERVER_URL: z.string().optional(),

  // NAV Worker
  NAV_WORKER_URL: z.string().default('http://localhost:3002'),

  // Webhooks
  QUICKNODE_WEBHOOK_SECRET: z.string().optional(),
  RELAY_WEBHOOK_SECRET: z.string().optional(),

  // Block event poller
  BLOCK_POLLER_ENABLED: z.coerce.boolean().default(false),
  BLOCK_POLLER_INTERVAL_MS: z.coerce.number().default(15000),

  // MuHaven Contract Addresses (Arb Sepolia)
  MUHAVEN_TOKEN_ADDRESS: z.string().optional(),
  MUHAVEN_VAULT_ADDRESS: z.string().optional(),
  INVESTOR_REGISTRY_ADDRESS: z.string().optional(),
  YIELD_DISTRIBUTOR_ADDRESS: z.string().optional(),
  KYC_ADAPTER_ADDRESS: z.string().optional(),
  RISK_PARAMS_ADDRESS: z.string().optional(),
  YIELD_GATE_ADDRESS: z.string().optional(),

  // ReineiraOS Contract Addresses (Arb Sepolia)
  REINEIRA_ESCROW_ADDRESS: z.string().optional(),
  PUSDC_WRAPPER_ADDRESS: z.string().optional(),
  SIMPLE_CONDITION_ADDRESS: z.string().optional(),
  CIRCLE_USDC_ADDRESS: z.string().optional(),
  REINEIRA_COORDINATOR_URL: z.string().optional(),

  // Demo-mode self-serve whitelist (/api/v1/demo/whitelist-self)
  // Private key of the current KYC adapter admin. See constraint: the
  // ERC3643KYCAdapter has a single `admin` slot (onlyAdmin), so this is
  // effectively the deployer key until the adapter is upgraded to multi-admin.
  // Leave blank to disable the endpoint entirely (returns 503).
  DEMO_WHITELIST_PRIVATE_KEY: z.string().optional(),

  // ── Wave 3.5 ───────────────────────────────────────────────────────
  // PriceOracle deployment used by the issuer NAV endpoints + NAV writer
  // cron. Same address regardless of token (per-token routing happens via
  // the `token` arg).
  ORACLE_ADDRESS: z.string().optional(),

  // ── Wave 3.5 Phase 7.5 — `MuHavenStable` confidential-USDC wrapper ──
  // Address of the deployed wrapper that replaces every Wave 3.5 use of
  // legacy PUSDC per `MHUSD_WRAPPER_PLAN.md` + ADR-041. Pre-cutover this
  // is unset; calldata-preparing endpoints that touch the cash leg should
  // refuse to encode against a missing slot rather than fall back to the
  // legacy PUSDC selector. Tax indexer is unaffected — Subscription /
  // Queue / YieldSnapshot events are still the source of truth.
  STABLE_ADDRESS: z.string().optional(),

  // NAV writer cron — pulls a fresh NAV from the Chainlink Functions
  // oracle for every registered Wave 3.5 token. Leave disabled in dev.
  NAV_CRON_ENABLED: z.coerce.boolean().default(false),
  NAV_CRON_INTERVAL_MS: z.coerce.number().default(60 * 60 * 1000), // 1h
  // EOA that has been granted `navRequester` on the ChainlinkFunctionsOracle.
  // Without it the cron logs a warning and stays idle.
  NAV_CRON_PRIVATE_KEY: z.string().optional(),

  // Tax-event indexer — polls Wave 3.5 contract events and stores
  // plaintext markers per ADR-020. Independent of the Wave 3 escrow
  // poller toggle so each can be turned on/off in isolation.
  TAX_EVENT_POLLER_ENABLED: z.coerce.boolean().default(false),
  TAX_EVENT_POLLER_INTERVAL_MS: z.coerce.number().default(15_000),
  SUBSCRIPTION_ADDRESS: z.string().optional(),
  // RedemptionQueue + YieldSnapshot deployments are per-token. The indexer
  // watches all addresses in these JSON arrays. Empty = disable that path.
  REDEMPTION_QUEUE_ADDRESSES_JSON: z.string().optional(),
  YIELD_SNAPSHOT_ADDRESSES_JSON: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (!_env) {
    _env = EnvSchema.parse(process.env);
  }
  return _env;
}
