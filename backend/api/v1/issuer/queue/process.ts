import { QueueProcessDtoSchema } from '../../../../src/application/dto/issuer/queue-process.dto.js';
import { PrepareQueueProcessUseCase } from '../../../../src/application/use-case/issuer/prepare-queue-process.use-case.js';
import { container } from '../../../../src/infrastructure/container.js';
import { createHandler } from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withRole } from '../../../../src/interface/middleware/with-role.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { Response } from '../../../../src/interface/response.js';

const useCase = new PrepareQueueProcessUseCase(container.rwaTokenRepo);

const handler = createHandler({
  operationName: 'PrepareQueueProcess',
  schema: QueueProcessDtoSchema,
  execute: async (dto, _req, authPayload) => {
    const result = await useCase.execute(dto, authPayload!.walletAddress);
    return Response.ok(result);
  },
});

export default withCors(withAuth(withRole('issuer', handler)));
