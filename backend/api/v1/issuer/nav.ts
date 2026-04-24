import { NavActionDtoSchema } from '../../../src/application/dto/issuer/nav.dto.js';
import { PrepareNavUseCase } from '../../../src/application/use-case/issuer/prepare-nav.use-case.js';
import { container } from '../../../src/infrastructure/container.js';
import { createHandler } from '../../../src/interface/handler-factory.js';
import { withAuth } from '../../../src/interface/middleware/with-auth.js';
import { withRole } from '../../../src/interface/middleware/with-role.js';
import { withCors } from '../../../src/interface/middleware/with-cors.js';
import { Response } from '../../../src/interface/response.js';

const useCase = new PrepareNavUseCase(container.rwaTokenRepo);

const handler = createHandler({
  operationName: 'PrepareNav',
  schema: NavActionDtoSchema,
  execute: async (dto, _req, authPayload) => {
    const result = await useCase.execute(dto, authPayload!.walletAddress);
    return Response.ok(result);
  },
});

export default withCors(withAuth(withRole('issuer', handler)));
