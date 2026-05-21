import { z } from 'zod';

// F1 follow-up from `@muhaven/mcp@0.2.1` multi-agent review
// (2026-05-18 / `project_session_2026_05_18_v021_landed`). The
// previous `symbol: z.string().min(1).max(10)` accepted ANY
// printable + non-printable character — including newlines,
// pipes, quotes, control chars — which let a malicious issuer
// register a symbol like `"OK\nIGNORE PRIOR INSTRUCTIONS"` and
// land it in the MCP-side `instructions` text as a prompt-
// injection vector. The MCP layer shipped a defense-in-depth
// `sanitizeSymbolForLlmContext()` (strips to `[A-Za-z0-9_-]`,
// caps at 16); this is the canonical write-boundary fix.
//
// Regex: alphanumeric only, first char must be a letter, 16-char
// cap. Matches every existing MuHaven RWA symbol (BUIDL, CETES,
// EUTBL, syrupUSDC, USDY, USYC, ONyc, MUon, NVDAon, STRCx, TSLAx,
// TBILL1, GOLD1) including the Wave 5 1A mixed-case ones that
// landed AFTER the original F1 recommendation (which had proposed
// the stricter `/^[A-Z][A-Z0-9]{0,11}$/` — that would reject
// `syrupUSDC` / `ONyc` / etc.). The 16-char cap matches MCP's
// sanitizer cap exactly so the two layers stay in lockstep.
const SYMBOL_REGEX = /^[A-Za-z][A-Za-z0-9]{0,15}$/;

export const CreateTokenDtoSchema = z.object({
  address: z.string().min(1).regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
  name: z.string().min(1).max(100),
  symbol: z
    .string()
    .regex(SYMBOL_REGEX, 'Symbol must be alphanumeric (first char letter), 1-16 chars'),
  apy: z.string().optional(),
  yield_schedule: z.string().optional(),
  kyc_tier: z.number().int().min(0).max(3),
  asset_class: z.enum(['treasury', 'money_market', 'private_credit', 'real_estate', 'other']),
  min_investment: z.string().optional(),
});

export type CreateTokenDto = z.infer<typeof CreateTokenDtoSchema>;

export interface LatestNavDto {
  nav: string;
  apy: string | null;
  total_aum: string | null;
  yield_rate: string | null;
  source: string;
  source_type: string;
  source_timestamp: string | null;
  fetched_at: string;
}

export interface TokenResponseDto {
  id: string;
  address: string;
  name: string;
  symbol: string;
  issuer_address: string;
  /**
   * Display name from the issuer's KYB submission (`users.issuer_display_name`).
   * Null when the issuer wallet hasn't walked the F2 onboarding wizard
   * (e.g. a Wave-3.5 demo issuer that pre-dates F2). Frontend falls back
   * to a formatted address when null.
   */
  issuer_display_name: string | null;
  apy: string | null;
  yield_schedule: string | null;
  kyc_tier: number;
  asset_class: string;
  min_investment: string | null;
  status: string;
  /**
   * Wave 5+ per-token YieldSnapshot proxy address (2026-05-23).
   * `null` for legacy tokens (deployed before per-token snapshots
   * shipped); frontend's `getYieldSnapshot(token)` falls back to the
   * env-baked singleton when this is null. Wizard-deployed tokens
   * always populate this at the `deploy_yield_snapshot` step.
   */
  yield_snapshot_address: string | null;
  created_at: string;
  updated_at: string;
  latest_nav: LatestNavDto | null;
}
