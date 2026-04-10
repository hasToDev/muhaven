import { VerifyWalletDtoSchema } from '../../../../src/application/dto/auth/verify-wallet.dto.js';
import { VerifyWalletUseCase } from '../../../../src/application/use-case/auth/verify-wallet.use-case.js';
import { container } from '../../../../src/infrastructure/container.js';
import { createHandler } from '../../../../src/interface/handler-factory.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withRateLimit } from '../../../../src/interface/middleware/with-rate-limit.js';
import { Response } from '../../../../src/interface/response.js';

const useCase = new VerifyWalletUseCase(
  container.siweVerifier,
  container.nonceService,
  container.userRepo,
  container.sessionRepo,
  container.jwtService,
);

const handler = createHandler({
  operationName: 'VerifyWallet',
  schema: VerifyWalletDtoSchema,
  execute: async (dto, req) => {
    const result = await useCase.execute(dto, {
      userAgent: req.headers['user-agent'],
      ipAddress: req.headers['x-forwarded-for']?.toString().split(',')[0].trim()
        ?? req.socket?.remoteAddress,
    });
    return Response.ok(result);
  },
});

// 10 verify attempts per minute per IP
export default withCors(withRateLimit({ maxRequests: 10, windowSeconds: 60 }, handler));
