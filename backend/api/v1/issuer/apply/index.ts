import { ApplyIssuerDtoSchema } from '../../../../src/application/dto/issuer/apply-issuer.dto.js';
import { ApplyIssuerUseCase } from '../../../../src/application/use-case/issuer/apply-issuer.use-case.js';
import { container } from '../../../../src/infrastructure/container.js';
import { createHandler } from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { Response } from '../../../../src/interface/response.js';

const useCase = new ApplyIssuerUseCase(
  container.userRepo,
  container.sessionRepo,
  container.portfolioRepo,
  container.taxEventRepo,
  container.jwtService,
);

// `withAuth` only — the applicant arrives as `investor` (default) or
// `unregistered` and is flipping to `issuer` here. `withRole('issuer')`
// would 403 before the use case runs.
const handler = createHandler({
  operationName: 'ApplyIssuer',
  schema: ApplyIssuerDtoSchema,
  execute: async (dto, req, authPayload) => {
    const result = await useCase.execute(authPayload!.userId, dto, {
      userAgent: req.headers['user-agent'],
      ipAddress:
        req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ??
        req.socket?.remoteAddress,
    });
    return Response.ok(result);
  },
});

export default withCors(withAuth(handler));
