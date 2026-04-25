import { StableOperatorActionDtoSchema } from '../../../src/application/dto/issuer/stable-operator.dto.js';
import { PrepareStableOperatorUseCase } from '../../../src/application/use-case/issuer/prepare-stable-operator.use-case.js';
import { createHandler } from '../../../src/interface/handler-factory.js';
import { withAuth } from '../../../src/interface/middleware/with-auth.js';
import { withRole } from '../../../src/interface/middleware/with-role.js';
import { withCors } from '../../../src/interface/middleware/with-cors.js';
import { Response } from '../../../src/interface/response.js';

const useCase = new PrepareStableOperatorUseCase();

const handler = createHandler({
  operationName: 'PrepareStableOperator',
  schema: StableOperatorActionDtoSchema,
  execute: async (dto) => {
    const result = await useCase.execute(dto);
    return Response.ok(result);
  },
});

export default withCors(withAuth(withRole('issuer', handler)));
