import { z } from 'zod';
import { ZodError } from 'zod';

const InvalidParamSchema = z.object({
  name: z.string(),
  reason: z.string(),
});

export const ErrorResponseDtoSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string().optional(),
  // Structured error payload — used by `ApplicationHttpError`'s
  // `details` slot when the use-case wants to hand the client a
  // machine-readable code + context (e.g. ROLE_MISMATCH carries
  // `{ code: 'ROLE_MISMATCH', registeredRole: 'investor' }` so the
  // login form can auto-flip its role toggle without parsing
  // `title`).
  details: z.unknown().optional(),
});

export const ValidationErrorResponseDtoSchema = ErrorResponseDtoSchema.extend({
  invalid_params: z.array(InvalidParamSchema),
});

export type InvalidParam = z.infer<typeof InvalidParamSchema>;
export type ErrorResponseDto = z.infer<typeof ErrorResponseDtoSchema>;
export type ValidationErrorResponseDto = z.infer<typeof ValidationErrorResponseDtoSchema>;

export class ErrorResponseDtoFactory {
  static create(
    status: number,
    title: string,
    detail?: string,
    details?: unknown,
  ): ErrorResponseDto {
    return {
      type: `https://httpstatuses.com/${status}`,
      title,
      status,
      ...(detail && { detail }),
      ...(details !== undefined && { details }),
    };
  }

  static createValidation(title: string, invalidParams: InvalidParam[], detail?: string): ValidationErrorResponseDto {
    return {
      type: 'https://httpstatuses.com/422',
      title,
      status: 422,
      invalid_params: invalidParams,
      ...(detail && { detail }),
    };
  }

  static fromError(error: Error, statusCode = 500): ErrorResponseDto {
    // ApplicationHttpError carries an optional `details` slot for
    // structured error payloads (e.g. ROLE_MISMATCH context). Surface
    // it on the wire alongside the title.
    const details =
      'details' in error ? (error as { details?: unknown }).details : undefined;
    return ErrorResponseDtoFactory.create(
      statusCode,
      error.message,
      undefined,
      details,
    );
  }

  static fromZodError(error: ZodError): ValidationErrorResponseDto {
    const invalidParams: InvalidParam[] = error.issues.map((issue) => ({
      name: issue.path.join('.'),
      reason: issue.message,
    }));

    return ErrorResponseDtoFactory.createValidation('Validation failed', invalidParams);
  }
}
