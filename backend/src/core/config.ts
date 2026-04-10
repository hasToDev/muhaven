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
});

export type Env = z.infer<typeof EnvSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (!_env) {
    _env = EnvSchema.parse(process.env);
  }
  return _env;
}
