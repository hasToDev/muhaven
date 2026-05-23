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

  // Wave 5 P4 — `CheckoutSettlementIndexer`. Watches
  // `MuHavenSubscription.Purchased` events on the Subscription proxy
  // and flips matching checkout sessions to `settled` so the buyer
  // page's `/checkout/<id>` view + the issuer dashboard both reflect
  // on-chain settlement automatically. Reuses `SUBSCRIPTION_ADDRESS`
  // + `RPC_URL` above. Disabled by default — operator enables once
  // the buyer-page P3 ceremony is producing real Subscription.purchase
  // txes (otherwise the indexer polls for nothing and burns RPC).
  CHECKOUT_SETTLEMENT_POLLER_ENABLED: z.coerce.boolean().default(false),
  CHECKOUT_SETTLEMENT_POLLER_INTERVAL_MS: z.coerce.number().default(8_000),
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
  // 2026-05-17 Design A · PREVENTION — platform-managed NAV writer EOA.
  // Address of the signer the platform uses to call
  // `IssuerControlledOracle.setNAV` for all self-serve-onboarded tokens.
  // Must equal the address derived from `PLATFORM_DEPLOYER_PRIVATE_KEY`
  // (asserted at boot in `IssuerOracleNavWriterService`). Today this is
  // the platform deployer EOA on prod (`0xe11E…6986`) — rotate to a
  // dedicated EOA pre-mainnet.
  PLATFORM_NAV_WRITER_ADDRESS: z.string().optional(),
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

  // ── Wave 4 Phase P6 — RiskParams adapter selection ─────────────────
  // `stub` (default) wires `StubRiskParamsAdapter` — always-pass; suitable
  // for dev / CI without an on-chain RiskParams deployment. `onchain`
  // wires `OnChainRiskParamsAdapter` which calls `RiskParams.checkAndExecute`
  // via viem + the FHE worker. The on-chain path requires `RPC_URL`,
  // `RISK_PARAMS_ADDRESS`, `AGENT_POLICY_PRIVATE_KEY`, and a healthy FHE
  // worker.
  RISK_PARAMS_ADAPTER: z.enum(['stub', 'onchain']).default('stub'),
  // Cron signer key (granted `owner` on the deployed RiskParams proxy).
  // Per ADR-1 §"AgentPermit"; this EOA is also the platform owner from
  // the perspective of `consumeAgentPermit` and `settleBreachDecrypt`.
  AGENT_POLICY_PRIVATE_KEY: z.string().optional(),

  // ── Wave 4 Phase P4 — OpenClaw / Telegram surface ──────────────────
  // Shared secret presented by the `telegram-bot/` worker on every
  // service-to-service call into the backend (`/api/v1/agent/openclaw/*`
  // worker-shaped routes). Min 32 chars (we enforce 16 in the middleware
  // for tests, 32+ in production env). Empty disables the worker integration
  // entirely — the routes return 503 instead of accepting unauthenticated
  // calls.
  TELEGRAM_BOT_SERVICE_SECRET: z.string().optional(),
  /** Bot token used to verify Mini App initData HMAC. Same string the
   *  telegram-bot/ worker holds as TELEGRAM_BOT_TOKEN. */
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  /** Telegram bot username (without `@`) used to render the t.me link. */
  TELEGRAM_BOT_USERNAME: z.string().optional(),
  /** Public Mini App URL ("web_app" target on the inline keyboard). */
  TELEGRAM_MINI_APP_URL: z.string().optional(),
  /** Wave 4 P7 — base URL of the running `telegram-bot/` worker so the
   *  backend can publish issuer-channel broadcasts (distribution-funded
   *  / KYC-changed / token-unpaused). Operator setup is deferred to
   *  the grant-submission window — when unset, the use-case falls back
   *  to the LoggingIssuerChannelTransport (events log + drop). */
  TELEGRAM_BOT_WORKER_URL: z.string().optional(),
  /** STAGING-ONLY tier-threshold overrides for the OpenClaw three-tier
   *  classifier (Wave 4 P4). The default ceilings are
   *  `OpenClawIntentTier.{Inline≤200, MiniAppOtp≤5000, PasskeyDeeplink>5000}`
   *  USDC. The staging walkthrough exercises mid-tier (Mini App + OTP)
   *  with a 2 mhUSDC test amount that would otherwise classify as
   *  inline; setting `OPENCLAW_TIER_INLINE_MAX_USD6=0` lowers the inline
   *  ceiling so even sub-dollar amounts route to mid-tier. The
   *  `classifyTier` validator REJECTS overrides ABOVE the regulatory
   *  caps — only LOWERING is supported. Production deploys MUST leave
   *  both unset (defaults apply). Both env values are USDC 6-decimal
   *  units serialised as strings (the schema parses to `bigint` via the
   *  use-case's z.string().transform(BigInt) wrapper, but the env-time
   *  contract is just a numeric string). */
  OPENCLAW_TIER_INLINE_MAX_USD6: z.string().regex(/^\d+$/).optional(),
  OPENCLAW_TIER_MINI_APP_MAX_USD6: z.string().regex(/^\d+$/).optional(),

  // ── Wave 4 Phase P5 — Hosted checkout `pay.muhaven.app` ────────────
  // Public base URL the checkout page is hosted at — used to build the
  // buyer-facing capability URL `<base>/c/<sessionId>#k=<key>`.
  // Production: `https://pay.muhaven.app`. Staging (subdomain on the same
  // apex so RP-ID resolves the same as the dashboard): `https://pay-stage.muhaven.app`.
  // Dev: the local Vite server on http://localhost:7780.
  CHECKOUT_PUBLIC_URL: z.string().default('http://localhost:7780'),

  // ── Wave 4 Phase P11 — DefaultProtection / EncryptedGovernance / KYC stubs ──
  // P11 contracts are not yet deployed to Arb Sepolia at Wave 4 close —
  // the four P11 agent tools (`muhaven_check_protection_coverage`,
  // `muhaven_explain_kyc_attestation`, `muhaven_propose_governance_vote`,
  // `muhaven_cast_encrypted_vote`) gracefully degrade when the proxy
  // addresses are unset: read tools return a structured "p11.not_deployed"
  // response; propose tools refuse with the same code rather than mint
  // ActionDescriptors that point at the zero address.
  DEFAULT_PROTECTION_ADDRESS: z.string().optional(),
  ENCRYPTED_GOVERNANCE_ADDRESS: z.string().optional(),
  KYC_ATTESTATION_REGISTRY_ADDRESS: z.string().optional(),

  // ── Wave 4 Phase P2 — HavenBot in-dashboard copilot ────────────────
  // Google Gemini API key (the user's available key — see ADR-6 for the
  // Claude → Gemini swap rationale). When unset, the chat surface falls
  // back to a deterministic intent classifier that emits the same SSE
  // wire shape so the UI keeps working in dev/CI without a key.
  GEMINI_API_KEY: z.string().optional(),
  // Model selector — default `gemini-2.5-flash` (current Flash tier as
  // of 2026-05-09; `gemini-2.0-flash` was retired for new users). Smaller
  // / cheaper than `pro`, fast enough for the ~6-min onboarding budget.
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),

  // ── Wave 5 Q1 — RWA oracle ingest (rwa.xyz scrape) ─────────────────
  // Shared secret presented by the operator script on
  // `POST /api/v1/admin/oracle/ingest`. Mirrors the
  // TELEGRAM_BOT_SERVICE_SECRET pattern: empty → endpoint returns 503,
  // wrong → 401. Operator runs the ingest from a dev machine; this is
  // NOT a user-facing auth path.
  ORACLE_INGEST_SERVICE_SECRET: z.string().optional(),

  // ── Wave 5 Q3 (step 3) — operator-alert surface ────────────────────
  // Single recipient chat-id the `NotifyYieldCronFailureUseCase`
  // forwards alerts to via the telegram-bot worker. Unset → the
  // container falls back to LoggingOperatorAlertTransport (alerts log
  // + drop). Set together with `TELEGRAM_BOT_WORKER_URL` +
  // `TELEGRAM_BOT_SERVICE_SECRET` to activate the HTTP transport.
  // The bot worker ALSO pins its own `OPERATOR_TELEGRAM_CHAT_ID` and
  // refuses to forward alerts to any other chat (Security H-3) — both
  // env vars must agree.
  OPERATOR_TELEGRAM_CHAT_ID: z.string().optional(),
  // Dedicated bearer secret for `POST /api/v1/operator/alert-test` —
  // NOT reused with `ORACLE_INGEST_SERVICE_SECRET`. A leak on either
  // surface MUST NOT compromise the other (v3.1 plan A1). Min 16 chars
  // matches `withServiceSecret` middleware's floor; we generate 32
  // random bytes hex-encoded per deploy. Round-1 Security M-5: schema
  // floor catches typo'd 8-char secrets at boot rather than letting
  // them surface as a silent 503 in prod.
  OPERATOR_ALERT_TEST_SECRET: z.string().min(16).optional(),

  // Wave 5 Option D · Commit 1 — shared service secret for the one-
  // shot operator-driven Scoped-session policy-migration endpoint
  // (`POST /api/v1/operator/option-d-c1-revoke-all-active-scoped-sessions`).
  // Min 16 chars matches `withServiceSecret` floor. Dedicated env
  // (NOT `OPERATOR_ALERT_TEST_SECRET`, NOT
  // `TELEGRAM_BOT_SERVICE_SECRET`) so a leak on one operator surface
  // doesn't compromise the migration endpoint — blast-radius
  // separation. Optional because most boots don't run the migration;
  // when unset the route returns 503 to unauthenticated and
  // authenticated callers alike.
  OPTION_D_C1_MIGRATION_SECRET: z.string().min(16).optional(),

  // Wave 5 Option D · Commit 2 — pgcrypto symmetric key for
  // `agent_scoped_sessions.enable_data` + `enable_sig` column-level
  // encrypt-at-rest. 64 hex chars (32 bytes), generated per-deploy via
  // `openssl rand -hex 32`. The same key encrypts AND decrypts; rotation
  // requires a coordinated re-encrypt of every populated row (handled by
  // an ops script — out of C2 scope).
  //
  // Optional because pre-C2 boots never had this key; the repository's
  // encrypted-write path throws loud if the key is missing AND a write
  // attempts to populate enableData / enableSig. Reads degrade cleanly
  // when the key is missing (the install-material subroute returns
  // 503 instead of leaking a partial response).
  //
  // SecEng follow-through (R2 Option D plan): cross-secret blast-radius
  // separation against every other operator-facing secret on this
  // surface — handled in the superRefine below.
  OPTION_D_C2_ENCRYPTION_KEY: z
    .string()
    .regex(
      /^[0-9a-fA-F]{64}$/,
      'OPTION_D_C2_ENCRYPTION_KEY must be 64 hex chars (32 bytes; generate via `openssl rand -hex 32`).',
    )
    .optional(),

  // Wave 5 Option D · Commit 2 — service-to-service shared secret for
  // the broker callback + install-material subroutes
  // (`GET  /api/v1/agent/policy/scoped-session/:sessionId/install-material`
  // ` POST /api/v1/agent/policy/scoped-session/:sessionId/validator-enabled` — C3).
  //
  // Both subroutes are internal-only — the MCP server (install-material
  // consumer) and the broker daemon (validator-enabled producer) hold
  // this secret. Browser clients NEVER see it; user-driven flows go
  // through the standard SIWE-JWT path on the sibling endpoints.
  //
  // Optional because the consumer wiring lands in C3; pre-C3 boots can
  // leave this unset and the subroutes return 503 to every caller
  // (including authenticated ones). Min 16 chars matches
  // `withServiceSecret` middleware's floor.
  BROKER_CALLBACK_SERVICE_SECRET: z.string().min(16).optional(),

  // ── Wave 5 Q3 (step 4) — daily yield-distribution cron ─────────────
  // Master toggle — default false so the cron is opt-in. Operator
  // flips this to true AFTER setting YIELD_CRON_PRIVATE_KEY +
  // YIELD_CRON_DRY_RUN=true for the 24h smoke (step 5).
  YIELD_CRON_ENABLED: z.coerce.boolean().default(false),
  // Issuer EOA private key — has `MINTER_ROLE` on the relevant
  // contracts AND a pre-wrapped mhUSDC float (Q3_PLAN.md A.5; operator
  // runs `scripts/wrap-pusdc-only.ts` to seed the buffer). Often the
  // SAME EOA as `NAV_CRON_PRIVATE_KEY` on prod, but kept as a
  // separate var so the two can rotate independently if needed.
  //
  // Round-1 Security H-3 (2026-05-21): regex-validated at the schema
  // boundary so any future entry point that constructs
  // `YieldDistributionCron` (test harness, ops script) gets the
  // shape check uniformly — the dev-server-only regex in step 4
  // wasn't reachable from those callers. Placeholder strings like
  // `<<FILL_ME>>` boot-fail loud instead of silently producing a
  // misconfigured Wallet inside viem.
  YIELD_CRON_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'YIELD_CRON_PRIVATE_KEY must be a 0x-prefixed 32-byte hex')
    .optional(),
  // Skip on-chain side effects + DB audit writes. The cron still
  // ticks + iterates tokens (so logs reflect what would have
  // happened) + fires a 6h-debounced Telegram alert so operators
  // notice they're in dry-run mode before flipping to live.
  YIELD_CRON_DRY_RUN: z.coerce.boolean().default(false),
  // Override the default '0 0 * * *' UTC schedule for testing /
  // staging. The cron validates the expression via `cron.validate()`
  // at start; invalid input logs a warn + falls back to the default.
  //
  // Round-1 Security H-4 (2026-05-21): semantic-shape guard. We
  // refuse expressions where the minute or hour field is anything
  // other than a single literal integer (0-59 / 0-23). That bans
  // every-minute (`* * * * *`), every-hour (`0 * * * *`), and step
  // forms (`*/5 * * * *`) — all of which would turn the cron into a
  // Postgres-connection storm + boot-alert spam under contention,
  // since the 23h DB guard only blocks the actual `fundEpoch` write
  // path, not the per-minute pool.connect() + advisory-lock attempts.
  // Daily / multi-hour fixed-time schedules pass; anything sub-
  // hourly rejects.
  YIELD_CRON_CRON_EXPR: z
    .string()
    .regex(
      /^(?:[0-9]|[1-5][0-9])\s+(?:[0-9]|1[0-9]|2[0-3])\s+\S+\s+\S+\s+\S+$/,
      'YIELD_CRON_CRON_EXPR must have a literal-integer minute (0-59) and hour (0-23) field; sub-hourly schedules rejected to avoid pool contention.',
    )
    .default('0 0 * * *'),
  // Global per-token effective overage cap, shares. The cron computes
  // `encTotalYield = effectiveCap × ratePerShare / RATE_SCALE`. This
  // is the issuer's deliberate overfunding budget per token-day —
  // excess mhUSDC stays in the YieldSnapshot proxy after `claimExpiry`
  // (overage reclaim is filed as future "Q3.1"; safe on testnet).
  //
  // Per-token override via `rwa_tokens.max_supply_cap_override` (DB
  // operator-set; see Q3_PLAN.md D.1.b). Bounded at parse time per
  // v3.1 A2 — config-parse-time floor + ceiling reject env override
  // sabotage (a typo'd `1e15` cap would silent-fail the uint64
  // narrowing in the runner; a typo'd `0` cap would short-circuit
  // every distribution to zero).
  YIELD_CRON_MAX_SUPPLY_CAP: z.coerce.bigint().min(1n).max(10_000_000_000n).default(10_000_000n),
  // Hard ceiling on oracle snapshot staleness — beyond this many days
  // the cron skips the token + fires WARN alert (v3.1 A5). Default 7d
  // matches the plan; lower it on prod once nav-worker reliability is
  // established to catch nav-worker outages faster.
  STALE_NAV_HALT_DAYS: z.coerce.number().int().min(1).max(30).default(7),
}).superRefine((env, ctx) => {
  // Round-1 Security L-3 — refuse boot when the two operator-scoped
  // service secrets are identical. Operators occasionally paste the
  // same secret into multiple slots; if `ORACLE_INGEST_SERVICE_SECRET`
  // and `OPERATOR_ALERT_TEST_SECRET` ever match, a leak on one surface
  // (ingest is the more-exposed one — the operator runs it from a dev
  // laptop) would silently grant access to the other (which fires
  // Telegram messages to the operator's phone via the live transport).
  // Loud-fail beats silent-wrong.
  if (
    env.OPERATOR_ALERT_TEST_SECRET &&
    env.ORACLE_INGEST_SERVICE_SECRET &&
    env.OPERATOR_ALERT_TEST_SECRET === env.ORACLE_INGEST_SERVICE_SECRET
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OPERATOR_ALERT_TEST_SECRET'],
      message:
        'OPERATOR_ALERT_TEST_SECRET must differ from ORACLE_INGEST_SERVICE_SECRET (blast-radius separation per Wave 5 Q3 plan A1)',
    });
  }
  // Wave 5 Option D · Commit 1 — same blast-radius pattern. The
  // migration endpoint is operator-driven, but a re-used secret would
  // mean an `ORACLE_INGEST_SERVICE_SECRET` or `OPERATOR_ALERT_TEST_SECRET`
  // leak grants access to a bulk-revoke surface. Loud-fail at boot.
  if (env.OPTION_D_C1_MIGRATION_SECRET) {
    if (
      env.ORACLE_INGEST_SERVICE_SECRET &&
      env.OPTION_D_C1_MIGRATION_SECRET === env.ORACLE_INGEST_SERVICE_SECRET
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPTION_D_C1_MIGRATION_SECRET'],
        message:
          'OPTION_D_C1_MIGRATION_SECRET must differ from ORACLE_INGEST_SERVICE_SECRET (blast-radius separation, Option D · C1).',
      });
    }
    if (
      env.OPERATOR_ALERT_TEST_SECRET &&
      env.OPTION_D_C1_MIGRATION_SECRET === env.OPERATOR_ALERT_TEST_SECRET
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPTION_D_C1_MIGRATION_SECRET'],
        message:
          'OPTION_D_C1_MIGRATION_SECRET must differ from OPERATOR_ALERT_TEST_SECRET (blast-radius separation, Option D · C1).',
      });
    }
    if (
      env.TELEGRAM_BOT_SERVICE_SECRET &&
      env.OPTION_D_C1_MIGRATION_SECRET === env.TELEGRAM_BOT_SERVICE_SECRET
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPTION_D_C1_MIGRATION_SECRET'],
        message:
          'OPTION_D_C1_MIGRATION_SECRET must differ from TELEGRAM_BOT_SERVICE_SECRET (blast-radius separation, Option D · C1).',
      });
    }
  }

  // Wave 5 Option D · Commit 2 — broker callback service secret must
  // not collide with any other operator-facing secret. Same blast-
  // radius separation reasoning as the C1 migration secret block above.
  if (env.BROKER_CALLBACK_SERVICE_SECRET) {
    const otherSecrets: Array<readonly [string, string | undefined]> = [
      ['ORACLE_INGEST_SERVICE_SECRET', env.ORACLE_INGEST_SERVICE_SECRET],
      ['OPERATOR_ALERT_TEST_SECRET', env.OPERATOR_ALERT_TEST_SECRET],
      ['TELEGRAM_BOT_SERVICE_SECRET', env.TELEGRAM_BOT_SERVICE_SECRET],
      ['OPTION_D_C1_MIGRATION_SECRET', env.OPTION_D_C1_MIGRATION_SECRET],
    ];
    for (const [name, value] of otherSecrets) {
      if (value && env.BROKER_CALLBACK_SERVICE_SECRET === value) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['BROKER_CALLBACK_SERVICE_SECRET'],
          message: `BROKER_CALLBACK_SERVICE_SECRET must differ from ${name} (blast-radius separation, Option D · C2).`,
        });
      }
    }
  }

  // Wave 5 Option D · Commit 2 — encryption key must not collide with
  // any operator-facing secret. The key isn't an HTTP credential, but a
  // re-used hex string indicates the operator paste-error class that
  // the rest of the cross-secret block defends against. Loud-fail at
  // boot.
  if (env.OPTION_D_C2_ENCRYPTION_KEY) {
    const otherSecrets: Array<readonly [string, string | undefined]> = [
      ['ORACLE_INGEST_SERVICE_SECRET', env.ORACLE_INGEST_SERVICE_SECRET],
      ['OPERATOR_ALERT_TEST_SECRET', env.OPERATOR_ALERT_TEST_SECRET],
      ['TELEGRAM_BOT_SERVICE_SECRET', env.TELEGRAM_BOT_SERVICE_SECRET],
      ['OPTION_D_C1_MIGRATION_SECRET', env.OPTION_D_C1_MIGRATION_SECRET],
      ['BROKER_CALLBACK_SERVICE_SECRET', env.BROKER_CALLBACK_SERVICE_SECRET],
    ];
    for (const [name, value] of otherSecrets) {
      if (value && env.OPTION_D_C2_ENCRYPTION_KEY === value) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['OPTION_D_C2_ENCRYPTION_KEY'],
          message: `OPTION_D_C2_ENCRYPTION_KEY must differ from ${name} (key/credential isolation, Option D · C2).`,
        });
      }
    }
  }
});

export type Env = z.infer<typeof EnvSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (!_env) {
    _env = EnvSchema.parse(process.env);
  }
  return _env;
}

/**
 * Wave 5 Option D · Commit 2 — TEST-ONLY env-cache reset.
 *
 * The env schema is parsed exactly once per process (cached in `_env`)
 * so production code paths never re-parse on hot calls. Integration
 * tests that need to mutate `process.env` between suites (e.g.
 * `OPTION_D_C2_ENCRYPTION_KEY` for the pgcrypto-roundtrip suite) must
 * call this AFTER mutating env to invalidate the cache. Multi-agent
 * review Codex M-5 absorbed.
 *
 * NOT for production callers. If a non-test path needs env reloads,
 * the call site is mis-architected — env should be set once at boot.
 */
export function resetEnvCacheForTesting(): void {
  _env = null;
}
