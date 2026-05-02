import { z } from 'zod';

/**
 * Phase 9.A · Expansion (F2) — wizard step 1 payload. KYB always-approved
 * for hackathon; `attestation` is a literal so the applicant has to
 * acknowledge that no real review happened.
 */
export const ApplyIssuerDtoSchema = z.object({
  display_name: z.string().trim().min(2).max(120),
  // ISO 3166-1 alpha-2; not a Zod-builtin enum so wizard can extend
  // jurisdictions without a backend deploy. Two-char uppercase guard.
  jurisdiction: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'Must be a 2-letter ISO 3166-1 alpha-2 country code'),
  contact_email: z.string().trim().email().max(254),
  attestation: z.literal('kyb_skipped'),
});

export type ApplyIssuerDto = z.infer<typeof ApplyIssuerDtoSchema>;

export interface ApplyIssuerResponseDto {
  user: {
    id: string;
    wallet_address: string;
    role: 'issuer';
    issuer_status: 'approved';
    issuer_display_name: string;
    issuer_jurisdiction: string;
    issuer_approved_at: string;
  };
  tokens: {
    access_token: string;
    refresh_token: string;
    token_type: 'Bearer';
    expires_in: number;
  };
}
