import 'reflect-metadata';
import {
  All,
  Catch,
  Controller,
  HttpException,
  Module,
  Req,
  Res,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { z, ZodError } from 'zod';
import {
  idSchema,
  persistedRowVersionSchema,
} from '../../../packages/contracts/src/base.js';
import type { ActorContext } from '../../../packages/contracts/src/identity.js';
import { Database } from '../../../packages/persistence/src/database.js';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { WebSessionService } from '../../../packages/application/src/identity/web-session.js';
import { ProjectService } from '../../../packages/application/src/projects/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';
import { RequirementService } from '../../../packages/application/src/requirements/service.js';
import { RequirementsController } from './requirements.controller.js';
import { mountFiles } from './files.js';
import { mountMcp } from './mcp.js';
import { SecretBroker } from '../../../packages/application/src/configuration/secrets.js';
import { ConfigurationService } from '../../../packages/application/src/configuration/service.js';
import { ConfigurationController } from './configuration.controller.js';
import { TestConfigurationService } from '../../../packages/application/src/test-configuration/service.js';
import { TestConfigurationController } from './test-configuration.controller.js';
import { AssetService } from '../../../packages/application/src/assets/service.js';
import { ReviewService } from '../../../packages/application/src/assets/reviews.js';
import { AssetsController } from './assets.controller.js';
import { PlanService } from '../../../packages/application/src/plans/service.js';
import { PlansController } from './plans.controller.js';
import { UiExecutionService } from '../../../packages/application/src/ui-executions/service.js';
import { ResultService } from '../../../packages/application/src/results/service.js';
import { UiDeliveryService } from '../../../packages/application/src/results/delivery.js';
import { UiDeliveryController } from './ui-delivery.controller.js';
import { ReportService } from '../../../packages/application/src/reports/service.js';
import { ResultsController } from './results.controller.js';
import { ApiExecutionControlService } from '../../../packages/application/src/api-execution/control.js';
import { ApiMultipartFiles } from '../../../packages/application/src/files/api-multipart.js';
import {
  ApiWorkerController,
  ApiExecutionController,
} from './api-execution.controller.js';
import { ConversationsController } from './conversations.controller.js';
import { WorkspaceDraftsController } from './workspace-drafts.controller.js';
import { WorkspaceDraftService } from '../../../packages/application/src/conversations/drafts.js';
import { ConversationsService } from '../../../packages/application/src/conversations/service.js';
import { AiTasksService } from '../../../packages/application/src/conversations/tasks.js';
import { FilePrivacyLedger } from '../../../packages/application/src/conversations/privacy.js';
import { ConversationFileReader } from '../../../packages/application/src/conversations/file-reader.js';
import { FilesService } from '../../../packages/application/src/files/service.js';
import { AgentWorkspaceService } from '../../../packages/application/src/agent-workspace/service.js';
import { FileCenterService } from '../../../packages/application/src/agent-workspace/file-center.js';
import { SandboxFilePreviewRenderer } from '../../../packages/application/src/file-preview/renderer.js';
import { FileCenterController } from './file-center.controller.js';
import { AgentWorkspaceController } from './agent-workspace.controller.js';
import { AgentMemoryService } from '../../../packages/application/src/agent-memory/service.js';
import { AgentMemoryController } from './agent-memory.controller.js';
import { createSandboxClientFromEnvironment } from '../../../packages/agent-runtime/src/environment.js';
import { AgentDocumentsService } from '../../../packages/application/src/agent-documents/service.js';
import { SandboxDocumentParser } from '../../../packages/application/src/agent-documents/sandbox-parser.js';
import { createAgentScheduleService } from '../../../packages/application/src/agent-schedules/factory.js';
import { AgentScheduleService } from '../../../packages/application/src/agent-schedules/service.js';
import { AgentSchedulesController } from './agent-schedules.controller.js';
import { createSemanticEmbeddingFromEnvironment } from '../../../packages/agent-embedding/src/client.js';
import { AgentRetrievalService } from '../../../packages/application/src/agent-retrieval/service.js';
import { AgentRetrievalController } from './agent-retrieval.controller.js';
import { createStorageFromEnvironment } from '../../../packages/storage/src/s3.js';
import { createBusinessRegistry } from '../../../packages/application/src/tool-registry/business.js';
import { registerInternalTools } from '../../../packages/application/src/tool-registry/internal.js';
import { ActionIntents } from '../../../packages/application/src/tool-registry/action-intents.js';
import { ActionIntentsController } from './action-intents.controller.js';
import { KnowledgeService } from '../../../packages/application/src/knowledge/service.js';
import { KnowledgeComparisons } from '../../../packages/application/src/knowledge/comparisons.js';
import { KnowledgeController } from './knowledge.controller.js';
import { RetestService } from '../../../packages/application/src/retests/service.js';
import { RetestsController } from './retests.controller.js';
import { NotificationService } from '../../../packages/application/src/notifications/service.js';
import { NotificationsController } from './notifications.controller.js';
import { ScheduleService } from '../../../packages/application/src/schedules/service.js';
import { SchedulesController } from './schedules.controller.js';
import { IssueService } from '../../../packages/application/src/issues/service.js';
import { IssueLifecycleService } from '../../../packages/application/src/issues/lifecycle.js';
import { ProblemService } from '../../../packages/application/src/issues/problems.js';
import { IssuesController } from './issues.controller.js';
import { AuxiliaryService } from '../../../packages/application/src/auxiliary/service.js';
import { AuxiliaryController } from './auxiliary.controller.js';
import { AutomaticAuxiliaryService } from '../../../packages/application/src/auxiliary/automatic.js';
import { AutomaticAuxiliaryController } from './automatic-auxiliary.controller.js';
import { ProjectOverviewService } from '../../../packages/application/src/projects/overview.js';
import { OverviewController } from './overview.controller.js';
import { ControlJournal } from '../../../packages/application/src/recovery/control-journal.js';
import { assertModelProtocolCheckpoint } from '../../../packages/application/src/configuration/model-checkpoint.js';
import { createModelDiscoveryPort } from '../../../packages/application/src/configuration/discovery.js';
import { createModelConnectionProbePort } from '../../../packages/application/src/configuration/model-connection-native.js';
import {
  MaintenanceService,
  recoverySchemaReady,
} from '../../../packages/application/src/recovery/maintenance.js';
import { OperationsService } from '../../../packages/application/src/recovery/service.js';
import { OperationsController } from './operations.controller.js';
import { ExternalMcpService } from '../../../packages/application/src/external-mcp/service.js';
import { ExternalMcpInvocations } from '../../../packages/application/src/external-mcp/invocations.js';
import { ExternalMcpController } from './external-mcp.controller.js';

function sessionFrom(req: Request): string | undefined {
  const match = req.headers.cookie
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('ath_session='));
  return match?.slice('ath_session='.length);
}

function bearerFrom(req: Request): string | undefined {
  const value = req.header('authorization');
  if (value === undefined) return undefined;
  if (!value.startsWith('Bearer ') || value.length > 512)
    throw new DomainError('UNAUTHENTICATED', '认证格式无效。', 401);
  return value.slice(7);
}

function cookie(res: Response, value: string, expiresAt: string | null) {
  res.cookie('ath_session', value, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.AITESTHUB_COOKIE_SECURE === 'true',
    path: '/',
    maxAge:
      expiresAt === null ? 0 : Math.max(0, Date.parse(expiresAt) - Date.now()),
  });
}

@Catch()
class SafeErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let failure: DomainError;
    if (error instanceof DomainError) failure = error;
    else if (error instanceof ZodError)
      failure = new DomainError(
        'VALIDATION_ERROR',
        '输入不符合契约，请检查字段。',
        400,
        {
          fields: error.issues
            .map((issue) => issue.path.join('.'))
            .join(', ')
            .slice(0, 1000),
        },
      );
    else if (error instanceof HttpException)
      failure = new DomainError(
        'VALIDATION_ERROR',
        '请求格式或大小不符合限制。',
        error.getStatus(),
      );
    else
      failure = new DomainError(
        'INTERNAL_ERROR',
        '服务处理失败，请查询当前状态后再决定是否重新提交。',
        500,
      );
    res.status(failure.status).json({
      error: {
        code: failure.code,
        message: failure.message,
        ...(failure.details ? { details: failure.details } : {}),
      },
      meta: { requestId: res.locals.requestId as string },
    });
  }
}

// Authentication throttling limits expensive password derivations; no credentials enter the keys/logs.
const authWindows = new Map<string, { count: number; until: number }>();
function authLimit(req: Request) {
  const key = req.socket.remoteAddress ?? 'local';
  const now = Date.now();
  const prior = authWindows.get(key);
  if (authWindows.size > 10_000)
    for (const [k, v] of authWindows) if (v.until < now) authWindows.delete(k);
  const window =
    prior && prior.until > now ? prior : { count: 0, until: now + 60_000 };
  authWindows.set(key, window);
  if (++window.count > 30)
    throw new DomainError(
      'RATE_LIMITED',
      '认证请求过于频繁，请稍后再试。',
      429,
    );
}

@Controller('api/v1')
class ApiController {
  constructor(
    readonly identity: IdentityService,
    readonly projects: ProjectService,
    readonly db: Database,
  ) {}

  @All('{*path}')
  async handle(@Req() req: Request, @Res() res: Response) {
    const path = req.path.replace(/^\/api\/v1\/?/, '').replace(/\/$/, '');
    const method = req.method;
    const body: unknown = req.body;
    const requestId = res.locals.requestId as string;
    if (path === 'health/live' && method === 'GET')
      return res.json({ status: 'live' });
    if (path === 'health/ready' && method === 'GET') {
      await this.db.query('SELECT 1');
      return res.json({ status: 'ready' });
    }
    if (path === 'auth/register' && method === 'POST') {
      authLimit(req);
      return res.status(201).json({ user: await this.identity.register(body) });
    }
    if (path === 'auth/login' && method === 'POST') {
      authLimit(req);
      const result = await this.identity.login(body);
      cookie(res, result.session, result.sessionInfo.cookieExpiresAt);
      return res.json({ user: result.user });
    }
    if (path === 'auth/reset-password' && method === 'POST') {
      authLimit(req);
      await this.identity.resetPassword(body);
      return res.json({ completed: true });
    }
    const actor: ActorContext = await this.identity.authenticate(
      sessionFrom(req),
      bearerFrom(req),
      requestId,
    );
    if (actor.entrypoint !== 'web')
      throw new DomainError(
        'FORBIDDEN',
        '个人 Key 仅用于官方 MCP 与专用文件通道。',
        403,
      );
    if (path === 'me' && method === 'GET')
      return res.json(await this.identity.me(actor));
    if (path === 'auth/session' && method === 'GET')
      return res.json({
        session: await new WebSessionService(this.db).status(
          actor,
          sessionFrom(req),
        ),
      });
    if (path === 'auth/session/renew' && method === 'POST') {
      const currentSession = sessionFrom(req);
      if (!currentSession)
        throw new DomainError('UNAUTHENTICATED', '请先登录。', 401);
      const result = await new WebSessionService(this.db).renew(
        actor,
        currentSession,
        body,
      );
      return res.json(result);
    }
    if (path === 'me' && method === 'PUT')
      return res.json(await this.identity.updateProfile(actor, body));
    if (path === 'auth/logout' && method === 'POST') {
      await this.identity.logout(sessionFrom(req));
      cookie(res, '', null);
      return res.json({ completed: true });
    }
    if (path === 'me/password' && method === 'POST') {
      await this.identity.changePassword(actor, body);
      cookie(res, '', null);
      return res.json({ completed: true });
    }
    if (path === 'me/keys' && method === 'GET')
      return res.json(await this.identity.keys(actor));
    if (path === 'me/keys' && method === 'POST')
      return res.status(201).json(await this.identity.createKey(actor, body));
    const keyId = /^me\/keys\/([^/]+)$/.exec(path)?.[1];
    if (keyId && method === 'DELETE') {
      await this.identity.revokeKey(actor, idSchema.parse(keyId));
      return res.json({ completed: true });
    }
    if (path === 'users' && method === 'GET')
      return res.json(
        await this.identity.listUsers(
          actor,
          z
            .string()
            .max(100)
            .parse(req.query.search ?? ''),
        ),
      );
    if (path === 'admin/users' && method === 'GET')
      return res.json(await this.identity.listUserPage(actor, req.query));
    const accountRemoval =
      /^admin\/users\/([^/]+)\/removal-receipts\/([^/]+)$/.exec(path);
    if (accountRemoval?.[1] && accountRemoval[2] && method === 'GET')
      return res.json(
        await this.identity.removalReceipt(
          actor,
          idSchema.parse(accountRemoval[1]),
          idSchema.parse(accountRemoval[2]),
        ),
      );
    const resetUserId = /^admin\/users\/([^/]+)\/password-reset$/.exec(
      path,
    )?.[1];
    if (resetUserId && method === 'POST')
      return res.json(
        await this.identity.issueReset(actor, idSchema.parse(resetUserId)),
      );
    const adminUserId = /^admin\/users\/([^/]+)$/.exec(path)?.[1];
    if (adminUserId && method === 'PUT') {
      await this.identity.updateUser(actor, idSchema.parse(adminUserId), body);
      return res.json({ completed: true });
    }
    if (adminUserId && method === 'DELETE')
      return res.json(
        await this.identity.removeUser(
          actor,
          idSchema.parse(adminUserId),
          body,
        ),
      );
    if (path === 'projects' && method === 'GET')
      return res.json(await this.projects.list(actor));
    if (path === 'projects' && method === 'POST')
      return res.status(201).json(await this.projects.create(actor, body));
    const memberPath = /^projects\/([^/]+)\/members(?:\/([^/]+))?$/.exec(path);
    const memberCandidatesProjectId =
      /^projects\/([^/]+)\/member-candidates$/.exec(path)?.[1];
    if (memberCandidatesProjectId && method === 'GET')
      return res.json(
        await this.projects.memberCandidates(
          actor,
          idSchema.parse(memberCandidatesProjectId),
          z
            .string()
            .max(100)
            .parse(req.query.search ?? ''),
        ),
      );
    if (memberPath?.[1]) {
      const projectId = idSchema.parse(memberPath[1]);
      if (!memberPath[2] && method === 'GET')
        return res.json(await this.projects.members(actor, projectId));
      if (memberPath[2]) {
        const userId = idSchema.parse(memberPath[2]);
        if (method === 'PUT') {
          await this.projects.updateMember(actor, projectId, userId, body);
          return res.json({ completed: true });
        }
        if (method === 'DELETE') {
          const version = persistedRowVersionSchema.parse(
            Number(req.query.rowVersion),
          );
          await this.projects.removeMember(actor, projectId, userId, version);
          return res.json({ completed: true });
        }
      }
    }
    throw new DomainError('NOT_FOUND', '没有此接口。', 404);
  }
}

export async function createApp(db: Database) {
  const recoveryReady = await recoverySchemaReady(db);
  if (
    !recoveryReady &&
    process.env.AITESTHUB_REQUIRE_RECOVERY_CONTROL === 'true'
  )
    throw new DomainError(
      'DEPENDENCY_UNAVAILABLE',
      '最新恢复控制迁移尚未部署，平台保持关闭。',
      503,
    );
  const controls = recoveryReady
    ? await ControlJournal.fromEnvironment(db)
    : null;
  if (controls) {
    await controls.initialize();
    await assertModelProtocolCheckpoint(db, controls);
  }
  const maintenance = controls
    ? new MaintenanceService(db, () => controls.assertCurrentSource())
    : null;
  const broker = await SecretBroker.fromEnvironment(db);
  const testConfiguration = new TestConfigurationService(db, broker);
  const plans = new PlanService(db, testConfiguration);
  const storage = await createStorageFromEnvironment();
  const apiExecution = await ApiExecutionControlService.fromEnvironment(
    db,
    plans,
    broker,
    new ApiMultipartFiles(storage),
  );
  const schedules = new ScheduleService(db, plans);
  const configuration = new ConfigurationService(db, broker, {
    modelDiscovery: createModelDiscoveryPort(),
    modelConnection: createModelConnectionProbePort(),
  });
  const externalMcp = new ExternalMcpService(db, broker);
  const externalInvocations = new ExternalMcpInvocations(db, externalMcp);
  const fileService = new FilesService(db, storage);
  const sandbox = await createSandboxClientFromEnvironment();
  const workspace = new AgentWorkspaceService(db, fileService);
  const fileCenter = new FileCenterService(
    workspace,
    sandbox ? new SandboxFilePreviewRenderer(sandbox) : undefined,
  );
  const documents = sandbox
    ? new AgentDocumentsService(fileService, new SandboxDocumentParser(sandbox))
    : undefined;
  const fileReader = new ConversationFileReader(fileService, documents);
  const auxiliary = new AuxiliaryService(db, configuration, broker, fileReader);
  const automaticAuxiliary = new AutomaticAuxiliaryService(auxiliary);
  const privacyLedger = await FilePrivacyLedger.fromEnvironment();
  await privacyLedger.reapply(db);
  const conversationsService = new ConversationsService(
    db,
    configuration,
    fileReader,
    privacyLedger,
  );
  const aiTasksService = new AiTasksService(db, configuration, fileReader);
  const embedding = await createSemanticEmbeddingFromEnvironment();
  const retrieval = embedding
    ? new AgentRetrievalService(
        db,
        fileService,
        documents,
        embedding,
        aiTasksService.references,
      )
    : undefined;
  const officeSchedules = createAgentScheduleService(
    db,
    conversationsService,
    aiTasksService,
  );
  const businessRegistry = createBusinessRegistry(db, {
    files: fileService,
    plans,
    testConfiguration,
    apiExecution,
    schedules,
    auxiliary,
  });
  registerInternalTools(businessRegistry, db);
  @Module({
    controllers: [
      ConfigurationController,
      TestConfigurationController,
      AssetsController,
      PlansController,
      ResultsController,
      UiDeliveryController,
      ApiWorkerController,
      ApiExecutionController,
      AgentWorkspaceController,
      FileCenterController,
      AgentMemoryController,
      AgentSchedulesController,
      ...(retrieval ? [AgentRetrievalController] : []),
      ActionIntentsController,
      ConversationsController,
      WorkspaceDraftsController,
      KnowledgeController,
      RetestsController,
      NotificationsController,
      SchedulesController,
      IssuesController,
      AuxiliaryController,
      AutomaticAuxiliaryController,
      ExternalMcpController,
      OverviewController,
      ...(controls ? [OperationsController] : []),
      RequirementsController,
      ApiController,
    ],
    providers: [
      { provide: Database, useValue: db },
      { provide: IdentityService, useValue: new IdentityService(db) },
      { provide: ProjectService, useValue: new ProjectService(db) },
      {
        provide: RequirementService,
        useValue: new RequirementService(
          db,
          undefined,
          auxiliary.requirementNameAdmission(),
        ),
      },
      {
        provide: ConfigurationService,
        useValue: configuration,
      },
      {
        provide: TestConfigurationService,
        useValue: testConfiguration,
      },
      { provide: AssetService, useValue: new AssetService(db) },
      { provide: ReviewService, useValue: new ReviewService(db) },
      { provide: PlanService, useValue: plans },
      {
        provide: UiExecutionService,
        useValue: new UiExecutionService(db, plans),
      },
      { provide: ResultService, useValue: new ResultService(db) },
      { provide: FilesService, useValue: fileService },
      { provide: AgentMemoryService, useValue: new AgentMemoryService(db) },
      { provide: AgentScheduleService, useValue: officeSchedules },
      ...(retrieval
        ? [{ provide: AgentRetrievalService, useValue: retrieval }]
        : []),
      {
        provide: AgentWorkspaceService,
        useValue: workspace,
      },
      { provide: FileCenterService, useValue: fileCenter },
      { provide: UiDeliveryService, useValue: new UiDeliveryService(db) },
      { provide: ReportService, useValue: new ReportService(db) },
      { provide: ApiExecutionControlService, useValue: apiExecution },
      {
        provide: ConversationsService,
        useValue: conversationsService,
      },
      {
        provide: WorkspaceDraftService,
        useValue: new WorkspaceDraftService(db),
      },
      {
        provide: AiTasksService,
        useValue: aiTasksService,
      },
      {
        provide: ActionIntents,
        useValue: new ActionIntents(db, businessRegistry),
      },
      { provide: KnowledgeService, useValue: new KnowledgeService(db) },
      { provide: KnowledgeComparisons, useValue: new KnowledgeComparisons(db) },
      { provide: RetestService, useValue: new RetestService(db, plans) },
      { provide: NotificationService, useValue: new NotificationService(db) },
      { provide: ScheduleService, useValue: schedules },
      { provide: IssueService, useValue: new IssueService(db) },
      {
        provide: IssueLifecycleService,
        useValue: new IssueLifecycleService(db),
      },
      { provide: ProblemService, useValue: new ProblemService(db) },
      { provide: AuxiliaryService, useValue: auxiliary },
      { provide: AutomaticAuxiliaryService, useValue: automaticAuxiliary },
      { provide: ExternalMcpService, useValue: externalMcp },
      { provide: ExternalMcpInvocations, useValue: externalInvocations },
      {
        provide: 'AITESTHUB_EXTERNAL_MCP_SHUTDOWN',
        useValue: { onModuleDestroy: () => externalInvocations.close() },
      },
      {
        provide: ProjectOverviewService,
        useValue: new ProjectOverviewService(db),
      },
      ...(controls
        ? [
            {
              provide: OperationsService,
              useValue: new OperationsService(db, controls),
            },
          ]
        : []),
    ],
  })
  class AppModule {}
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['warn', 'error'],
    bodyParser: false,
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.locals.requestId = randomUUID();
    res.setHeader('X-Request-ID', res.locals.requestId as string);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    const origin = req.header('origin');
    const allowed = new Set([
      process.env.AITESTHUB_PUBLIC_ORIGIN ?? 'http://127.0.0.1:5300',
      'http://127.0.0.1:5173',
      'http://localhost:5300',
      'http://localhost:5173',
    ]);
    const crossSite = req.header('sec-fetch-site') === 'cross-site';
    // The Markdown preview runs in an opaque sandbox. Its two public,
    // immutable script assets load as cross-site classic scripts.
    const markdownDiagramScript =
      crossSite &&
      (req.method === 'GET' || req.method === 'HEAD') &&
      (origin === undefined || origin === 'null') &&
      req.header('sec-fetch-mode') === 'no-cors' &&
      req.header('sec-fetch-dest') === 'script' &&
      /^\/assets\/(?:mermaid\.tiny|markdown-mermaid-frame)-[\w-]{8}\.js$/.test(
        req.path,
      );
    if (
      !markdownDiagramScript &&
      ((origin && !allowed.has(origin)) || crossSite)
    ) {
      res.status(403).json({
        error: { code: 'FORBIDDEN', message: '请求来源不受允许。' },
        meta: { requestId: res.locals.requestId },
      });
      return;
    }
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      !req.header('authorization') &&
      req.header('x-ath-csrf') !== '1'
    ) {
      res.status(403).json({
        error: { code: 'FORBIDDEN', message: '缺少请求来源校验。' },
        meta: { requestId: res.locals.requestId },
      });
      return;
    }
    next();
  });
  const identity = app.get(IdentityService);
  if (maintenance) app.use(maintenance.middleware());
  const files = await mountFiles(app, db, identity, storage, fileService);
  app.getHttpServer().once('close', () => storage.close());
  mountMcp(app, db, identity, {
    files,
    testConfiguration: app.get(TestConfigurationService),
    plans,
    apiExecution,
    schedules,
    auxiliary,
  });
  app.useBodyParser('json', { limit: '1mb' });
  app.useGlobalFilters(new SafeErrorFilter());
  app.useStaticAssets(resolve('apps/web/dist'));
  await app.init();
  return app;
}
