import { AddWhitelistDtoSchema } from '../../../../src/application/dto/issuer/whitelist.dto.js';
import { PrepareAddWhitelistUseCase } from '../../../../src/application/use-case/issuer/prepare-whitelist.use-case.js';
import { createHandler } from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withRole } from '../../../../src/interface/middleware/with-role.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { Response } from '../../../../src/interface/response.js';

const useCase = new PrepareAddWhitelistUseCase();

const handler = createHandler({
  operationName: 'PrepareAddWhitelist',
  schema: AddWhitelistDtoSchema,
  execute: async (dto) => {
    const result = await useCase.execute(dto);
    return Response.ok(result);
  },
});

export default withCors(withAuth(withRole('issuer', handler)));
