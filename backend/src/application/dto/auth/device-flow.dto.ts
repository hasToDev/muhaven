import { z } from 'zod';
import { USER_CODE_REGEX } from '../../use-case/auth/device-flow.use-case.js';

export const DeviceCodeRequestDtoSchema = z
  .object({
    requesterMetadata: z
      .object({
        processName: z.string().min(1).max(64),
        hostname: z.string().max(253).default(''),
        os: z.string().max(64).default(''),
      })
      .strict(),
  })
  .strict();

export type DeviceCodeRequestDto = z.infer<typeof DeviceCodeRequestDtoSchema>;

// Wave 4 P3 ADR-3 §"Code Review #2 (post-port hardening)": the DTO regex
// is the OUTER guard at the wire boundary; the use-case regex is the
// INNER guard after .toUpperCase(). Both derive from the same alphabet
// so a loose `[A-Z0-9]` regex can't admit lookalike chars (O/I/0/1/L)
// at the DTO layer that get rejected at the use-case layer (small
// disclosure oracle between lookup-200 and authorize-400).
export const DeviceAuthorizeDtoSchema = z
  .object({
    userCode: z
      .string()
      .transform((s) => s.toUpperCase())
      .pipe(z.string().regex(USER_CODE_REGEX)),
    deny: z.boolean().optional(),
    denyReason: z.string().max(200).optional(),
  })
  .strict();

export type DeviceAuthorizeDto = z.infer<typeof DeviceAuthorizeDtoSchema>;

export const DeviceTokenPollDtoSchema = z
  .object({
    deviceCode: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type DeviceTokenPollDto = z.infer<typeof DeviceTokenPollDtoSchema>;
