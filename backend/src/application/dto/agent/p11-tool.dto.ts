import { z } from 'zod';

/**
 * Wave 4 Phase P11 — protection / governance / KYC-attestation tool surface.
 *
 * Four HavenBot tools — wires the P11.A DefaultProtection + P11.B
 * EncryptedGovernance + P11.C KYC attestation contract surfaces into
 * the agent-tool catalog so the LLM can answer authoritatively about
 * the on-chain protection coverage / governance / cross-chain KYC
 * primitives. Two are read-only (no propose ceremony, no signed tx);
 * two are propose-tools that mint ActionDescriptors the ConfirmModal
 * routes through the existing commit loop.
 *
 * P11 contracts are not yet deployed to Arb Sepolia at Wave 4 close —
 * each tool's use-case checks the relevant env-var address and returns
 * a structured `p11.not_deployed` payload (read tools) or refuses with
 * `409 P11_NOT_DEPLOYED` (propose tools) when the address is unset, so
 * the LLM gets a coherent answer instead of an opaque RPC error.
 */

const HEX_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const addressSchema = z
  .string()
  .regex(HEX_ADDRESS_RE, 'Must be a 0x-prefixed 40-hex EVM address');

// ─────────────────────────────────────────────────────────────────────
// Tool 12 — muhaven_check_protection_coverage  (read; no policy gate)
// ─────────────────────────────────────────────────────────────────────

export const CheckProtectionCoverageDtoSchema = z
  .object({
    /** RWA token address whose protection coverage to inspect. */
    tokenAddress: addressSchema,
  })
  .strict();

export type CheckProtectionCoverageDto = z.infer<typeof CheckProtectionCoverageDtoSchema>;

export interface CheckProtectionCoverageResponseDto {
  tool: 'muhaven_check_protection_coverage';
  tokenAddress: string;
  /** Status flag:
   *  - `'not_deployed'`   — DEFAULT_PROTECTION_ADDRESS is unset (Wave 4 close state).
   *  - `'no_protection'`  — `tokenProtection(token) == 0`; no reserve has been created.
   *  - `'inactive'`       — protection created but reserve hasn't been deposited.
   *  - `'active'`         — reserve funded; payout would fire on trigger.
   *  - `'triggered'`      — payout has been triggered; reserve being distributed.
   *  - `'distributing'` / `'completed'` — payout pipeline state.
   */
  status:
    | 'not_deployed'
    | 'no_protection'
    | 'inactive'
    | 'active'
    | 'triggered'
    | 'distributing'
    | 'completed';
  protectionId: string | null;
  /** Public reserveRateBps (cleartext on-chain — used to pre-fund the
   *  reserve at issuer onboarding). 1bps = 0.01%. */
  reserveRateBps: number | null;
  /** Issuer wallet that deposited the reserve. `null` until the
   *  protection record exists. */
  issuerAddress: string | null;
  /** Human-readable explanation the LLM can quote into a summary turn.
   *  Cleartext-only; never includes encrypted handles. */
  explanation: string;
}

// ─────────────────────────────────────────────────────────────────────
// Tool 13 — muhaven_explain_kyc_attestation  (read; informational)
// ─────────────────────────────────────────────────────────────────────

export const ExplainKycAttestationDtoSchema = z
  .object({
    /** Optional — describe ONE investor's attestation state. Defaults
     *  to the calling user's own wallet. */
    investorAddress: addressSchema.optional(),
  })
  .strict();

export type ExplainKycAttestationDto = z.infer<typeof ExplainKycAttestationDtoSchema>;

export interface ExplainKycAttestationResponseDto {
  tool: 'muhaven_explain_kyc_attestation';
  /** `'not_deployed'` when KYC_ATTESTATION_REGISTRY_ADDRESS is unset;
   *  `'live'` once the P11.C registry is on-chain. */
  status: 'not_deployed' | 'live';
  investorAddress: string | null;
  /** Cleartext jurisdiction hash (keccak256("US"), keccak256("EU"), …)
   *  set by the registry admin. `null` when not configured. */
  jurisdictionHash: string | null;
  /** Default validity period (seconds) for newly prepared attestations. */
  defaultValidityPeriodSec: number | null;
  /** Address of the EIP-712 signer the destination-chain verifier
   *  recognises. `null` when the registry isn't deployed. */
  attestationSigner: string | null;
  /** Static narrative describing the cross-chain attestation flow. The
   *  LLM can quote this verbatim — it's tuned to be informational
   *  without making promises about specific timing or jurisdictions. */
  narrative: string;
}

// ─────────────────────────────────────────────────────────────────────
// Tool 14 — muhaven_propose_governance_vote  (propose; tier-gated)
// ─────────────────────────────────────────────────────────────────────

const proposalTypeSchema = z.union([z.literal(0), z.literal(1)]);

export const ProposeGovernanceVoteDtoSchema = z
  .object({
    /** Token whose governance proposal is being raised. */
    tokenAddress: addressSchema,
    /** Encoded EncryptedGovernance proposal type — 0 = TRIGGER_PROTECTION
     *  (the only Wave 4 type per the contract); 1 reserved for Wave 5. */
    proposalType: proposalTypeSchema,
  })
  .strict();

export type ProposeGovernanceVoteDto = z.infer<typeof ProposeGovernanceVoteDtoSchema>;

// ─────────────────────────────────────────────────────────────────────
// Tool 15 — muhaven_cast_encrypted_vote  (propose; tier-gated)
// ─────────────────────────────────────────────────────────────────────

export const CastEncryptedVoteDtoSchema = z
  .object({
    /** Proposal id minted by `EncryptedGovernance.createProposal`. */
    proposalId: z.string().regex(/^[1-9]\d*$/, 'must be a positive integer string'),
    /** Cleartext yes/no — the SDK encrypts to InEuint128 client-side
     *  before the contract write so the agent surface never sees the
     *  encrypted handle. */
    voteYes: z.boolean(),
  })
  .strict();

export type CastEncryptedVoteDto = z.infer<typeof CastEncryptedVoteDtoSchema>;
