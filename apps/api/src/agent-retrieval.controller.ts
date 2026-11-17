import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { retrievalSearchInputSchema } from '../../../packages/contracts/src/agent-retrieval.js';
import { AgentRetrievalService } from '../../../packages/application/src/agent-retrieval/service.js';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { conversationRow } from '../../../packages/application/src/conversations/common.js';
import { DomainError } from '../../../packages/application/src/errors.js';

const httpInputSchema = retrievalSearchInputSchema.extend({
  conversationId: z.uuid(),
  dataScope: z.enum(['syntheticPublicOnly', 'authorizedRelevantTestData']),
});
@Controller('api/v1/me/agent-retrieval')
export class AgentRetrievalController {
  constructor(
    @Inject(AgentRetrievalService) readonly retrieval: AgentRetrievalService,
    @Inject(IdentityService) readonly identity: IdentityService,
  ) {}
  @All('search')
  async search(@Req() request: Request, @Res() response: Response) {
    if (request.method !== 'POST')
      throw new DomainError('NOT_FOUND', '检索接口不存在。', 404);
    const cookie = request.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('ath_session='))
      ?.slice('ath_session='.length);
    const actor = await this.identity.authenticate(
      cookie,
      undefined,
      String(response.locals.requestId),
    );
    if (actor.entrypoint !== 'web')
      throw new DomainError(
        'FORBIDDEN',
        '个人资料检索只开放本人网页及受控任务。',
        403,
      );
    const input = httpInputSchema.parse(request.body);
    const authorize = async () => {
      await this.retrieval.db.transaction((tx) =>
        conversationRow(tx, actor, input.conversationId, false),
      );
    };
    const result = await this.retrieval.search(
      actor,
      { query: input.query, sources: input.sources, limit: input.limit },
      {
        conversationId: input.conversationId,
        dataScope: input.dataScope,
        authorize,
        authorizeSource: async () => {
          await authorize();
        },
      },
    );
    return response.json(result);
  }
}
