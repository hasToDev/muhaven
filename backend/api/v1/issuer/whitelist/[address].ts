import type { VercelRequest, VercelResponse } from '@vercel/node';
import { PrepareRemoveWhitelistUseCase } from '../../../../src/application/use-case/issuer/prepare-whitelist.use-case.js';
import { createGetHandler, sendResponse } from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withRole } from '../../../../src/interface/middleware/with-role.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { Response } from '../../../../src/interface/response.js';

const useCase = new PrepareRemoveWhitelistUseCase();

// DELETE is handled via createGetHandler since there's no request body
const deleteHandler = createGetHandler({
  operationName: 'PrepareRemoveWhitelist',
  execute: async (req) => {
    const address = req.query.address as string | undefined;
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return Response.badRequest('Invalid address format');
    }
    const result = await useCase.execute(address);
    return Response.ok(result);
  },
});

const handler = async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  if (req.method === 'DELETE') {
    return deleteHandler(req, res);
  }
  sendResponse(res, Response.badRequest('Method not allowed'));
};

export default withCors(withAuth(withRole('issuer', handler)));
