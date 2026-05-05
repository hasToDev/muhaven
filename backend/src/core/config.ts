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
  // Phase 9.A · Option Z follow-up — per-RWA MuHavenToken proxies. The
  // indexer subscribes to broadened `Transfer(from, to, amount)` logs,
  // filters out mints / burns / protocol-mediated moves, and stores two
  // `tax_events` rows per surviving P2P transfer (sender + recipient).
  // Empty = disable the transfer leg of the feed.
  MUHAVEN_TOKEN_ADDRESSES_JSON: z.string().optional(),
  // Phase 9.A · Option Z follow-up — addresses whose Transfer
  // participation is filtered out before activity-row insertion. Mints
  // and burns are caught by `from == 0` / `to == 0`; this set adds the
  // protocol's own treasuries (and any other contract that participates
  // in protocol-internal Transfer events that the user shouldn't see as
  // a P2P move). Subscription + queue addresses configured above are
  // automatically included; this var is for the additional contracts
  // (typically MuHavenTreasury proxies, one per RWA).
  TREASURY_ADDRESSES_JSON: z.string().optional(),

  // ── Wave 3.5 Phase 8 — TokenRegistry (read by seed-tokens-v35 script) ──
  // Source of truth for "which tokens are registered". The seed script
  // calls `getRegisteredTokens` to discover symbols + addresses without a
  // filesystem dependency on the deployments JSON (which doesn't ship into
  // the backend container).
  TOKEN_REGISTRY_ADDRESS: z.string().optional(),

  // ── Phase 9.A · Expansion (F2) — self-serve issuer onboarding ──────
  // Platform addresses needed by `deploy-token.library.ts`. None are
  // dev-server-required: the apply endpoint works without them; only
  // the deploy endpoint refuses to start when any are missing.
  // Singular versions of YieldSnapshot / InvestorRegistry / Compliance
  // / IdentityRegistry / IssuerControlledOracle — the indexer's
  // `*_JSON` lists are per-token *subscriptions*, while the platform
  // contracts here are single-deployment singletons.
  ISSUER_ONBOARDING_ENABLED: z.coerce.boolean().default(false),
  PLATFORM_DEPLOYER_PRIVATE_KEY: z.string().optional(),
  INVESTOR_REGISTRY_V35_ADDRESS: z.string().optional(),
  YIELD_SNAPSHOT_ADDRESS: z.string().optional(),
  IDENTITY_REGISTRY_ADDRESS: z.string().optional(),
  MODULAR_COMPLIANCE_ADDRESS: z.string().optional(),
  ISSUER_ORACLE_ADDRESS: z.string().optional(),
  // Path to compiled contract artifacts inside the backend container.
  // Defaults to walking up to project root in dev; the Dockerfile bakes
  // artifacts into `/app/contracts-artifacts` for staging.
  MUHAVEN_ARTIFACTS_DIR: z.string().optional(),

  // ── Wave 4 Phase P1 — Tiered-autonomy policy engine ────────────────
  // The cron policy engine ticks every `AGENT_POLICY_CRON_INTERVAL_MS`
  // (default 60s per ADR-0). When disabled the engine never fires —
  // useful for dev environments without DB or for surfacing the cron
  // exclusively via on-demand tick endpoints later.
  AGENT_POLICY_CRON_ENABLED: z.coerce.boolean().default(false),
  AGENT_POLICY_CRON_INTERVAL_MS: z.coerce.number().default(60_000),
});

export type Env = z.infer<typeof EnvSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (!_env) {
    _env = EnvSchema.parse(process.env);
  }
  return _env;
}
