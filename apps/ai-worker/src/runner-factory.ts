import { z } from 'zod';
import { createHash } from 'node:crypto';
import { agentContextBudgetSnapshotSchema } from '../../../packages/contracts/src/agent-context.js';
import type { Database } from '../../../packages/persistence/src/database.js';
import { ConfigurationService } from '../../../packages/application/src/configuration/service.js';
import { SecretBroker } from '../../../packages/application/src/configuration/secrets.js';
import type {
  ConversationRunnerFactory,
  ConversationRunner,
} from '../../../packages/application/src/conversations/tasks.js';
import {
  createModelBudgetCalibration,
  type ModelBudgetCalibration,
} from '../../../packages/model-adapters/src/index.js';
import { createNativeModelAdapter } from '../../../packages/model-adapters/src/index.js';
import { NativeAdapterChatModel } from './adapter-model.js';
import { RestrictedAiHost } from './host.js';
import { DomainError } from '../../../packages/application/src/errors.js';
import { TestConfigurationService } from '../../../packages/application/src/test-configuration/service.js';
import { PlanService } from '../../../packages/application/src/plans/service.js';
import { ApiExecutionControlService } from '../../../packages/application/src/api-execution/control.js';
import { ScheduleService } from '../../../packages/application/src/schedules/service.js';
import { AuxiliaryService } from '../../../packages/application/src/auxiliary/service.js';
import { ExternalMcpService } from '../../../packages/application/src/external-mcp/service.js';
import { ExternalMcpInvocations } from '../../../packages/application/src/external-mcp/invocations.js';
import type { AiModelRetryPolicy } from '../../../packages/application/src/ai/model-retry.js';
import type { PersonalFileReader } from '../../../packages/application/src/conversations/references.js';
import { resolveModelOutputBudget } from '../../../packages/application/src/ai/model-output-budget.js';
import { AgentWebService } from '../../../packages/application/src/agent-web/service.js';
import type { AgentCalculationService } from '../../../packages/application/src/agent-calculation/service.js';
import type { AgentDocumentsService } from '../../../packages/application/src/agent-documents/service.js';
import type { AgentScheduleService } from '../../../packages/application/src/agent-schedules/service.js';
import { AgentOfficeService } from '../../../packages/application/src/agent-office/service.js';
import type { AgentRepositoryService } from '../../../packages/application/src/agent-repository/service.js';
import type { AgentRetrievalService } from '../../../packages/application/src/agent-retrieval/service.js';
import type { AgentBrowserService } from '../../../packages/application/src/agent-browser/service.js';

/** Only the worker owns this factory. Model/credentials never become tool arguments. */
export function createConversationRunnerFactory(
  db: Database,
  configuration: ConfigurationService,
  broker: SecretBroker,
  options: {
    modelRetryPolicy?: Partial<AiModelRetryPolicy>;
    fileReader?: PersonalFileReader;
    searchEndpoint?: string;
    calculation?: AgentCalculationService;
    documents?: AgentDocumentsService;
    officeSchedules?: AgentScheduleService;
    repository?: AgentRepositoryService;
    retrieval?: AgentRetrievalService;
    browser?: AgentBrowserService;
  } = {},
): ConversationRunnerFactory {
  const budgetCalibration = new Map<string, ModelBudgetCalibration>();
  return async (selection, actor) => {
    const outputBudget = resolveModelOutputBudget(selection);
    if (!selection.contextLimit)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '模型上下文Token窗口尚未明确配置，无法核对完整请求预算。',
        422,
      );
    const testConfiguration = new TestConfigurationService(db, broker);
    const plans = new PlanService(db, testConfiguration);
    const externalMcp = new ExternalMcpService(db, broker);
    const schedules = new ScheduleService(db, plans);
    const apiExecution = ApiExecutionControlService.forBusinessTools(
      db,
      plans,
      broker,
    );
    let activeIntentId: string | null = null;
    let activeInput: Parameters<ConversationRunner['run']>[1] | undefined;
    const v2 = 'runtimeVersion' in selection;
    const budgetKey = JSON.stringify({
      owner: actor.userId,
      service: selection.modelServiceId,
      entry: v2 ? selection.modelEntryId : selection.modelId,
      revision: v2 ? selection.serviceRevision : selection.configRevision,
      protocol: v2 ? selection.protocol : 'chatCompletions',
    });
    let calibration = budgetCalibration.get(budgetKey);
    if (!calibration) {
      calibration = createModelBudgetCalibration();
      budgetCalibration.set(budgetKey, calibration);
    }
    const native = createNativeModelAdapter(
      v2 ? selection.protocol : 'chatCompletions',
      {
        baseUrl: selection.baseUrl,
        model: selection.modelId,
        ...(selection.contextLimit
          ? { contextLimit: selection.contextLimit }
          : {}),
        contextBudgetCalibration: calibration,
        onContextBudget: (budget) => {
          if (activeInput && activeIntentId)
            activeInput.onEvent({
              type: 'contextBudget',
              stage: 'dispatch',
              modelAttemptId: activeIntentId,
              budget: agentContextBudgetSnapshotSchema.parse(budget),
            });
        },
        // Only an administrator-saved loopback HTTP endpoint can pass the native adapter guard.
        allowLocalHttp: true,
        ...(v2 ? { authScheme: selection.authScheme } : {}),
        timeoutMs: 60_000,
        onFetchStarted: (timing) => {
          if (activeInput && activeIntentId)
            activeInput.onEvent({
              type: 'modelDispatched',
              segmentId: activeIntentId,
              ...timing,
            });
        },
        onDispatch: async (attempt) => {
          await activeInput?.authorizeContext();
          if (!activeIntentId)
            throw new DomainError(
              'PRECONDITIONS_MISSING',
              '模型发送缺少持久意图，不会发送。',
              422,
            );
          const updated = await db.query(
            "UPDATE app.model_call_ledger SET client_request_id=$2 WHERE id=$1 AND initiator_user_id=$3 AND model_service_id=$4 AND status='dispatchIntent' RETURNING id",
            [
              activeIntentId,
              attempt.clientRequestId,
              actor.userId,
              selection.modelServiceId,
            ],
          );
          if (!updated.rowCount)
            throw new DomainError(
              'BUSINESS_CONFLICT',
              '模型发送意图已失效，不会重放。',
              409,
            );
        },
        credential: async () => {
          const current = await configuration.resolveRuntimeSelection(
            actor,
            v2
              ? {
                  modelServiceId: selection.modelServiceId,
                  modelEntryId: selection.modelEntryId,
                  serviceRevision: selection.serviceRevision,
                  effort: selection.effort,
                }
              : {
                  modelServiceId: selection.modelServiceId,
                  configRevision: selection.configRevision,
                  effort: selection.effort,
                },
          );
          return broker.resolve(current.credentialRef, {
            ownerScope: 'platform',
            ownerId: current.modelServiceId,
            purpose: 'model-api-key',
          });
        },
      },
    );
    const supportedEffort = z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,39}$/)
      .safeParse(selection.effort);
    if (selection.effort !== null && !supportedEffort.success)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '当前模型adapter未验证此思考强度，请重新选择；不会静默换强度。',
        422,
      );
    const effort = supportedEffort.success ? supportedEffort.data : undefined;
    // The checked selector already owns the limits; an old accepted revision may
    // legitimately survive the technical schema-upgrade binding without becoming today's row.
    const model = new NativeAdapterChatModel(native, {
      maxTokens: outputBudget,
      ...(effort ? { reasoningEffort: effort } : {}),
      onTextDelta: (text) => {
        if (activeInput && activeIntentId)
          activeInput.onEvent({
            type: 'text',
            text,
            modelAttemptId: activeIntentId,
            receivedAt: new Date().toISOString(),
            receivedMonotonicMs: performance.now(),
          });
      },
      onSummaryDelta: (text, summaryIndex) => {
        if (activeInput && activeIntentId)
          activeInput.onEvent({
            type: 'summary',
            segmentId: activeIntentId,
            summaryIndex,
            text,
          });
      },
    });
    const host = new RestrictedAiHost(db, model, {
      nativeTextEvents: true,
      ...(options.browser ? { browser: options.browser } : {}),
      ...(options.retrieval ? { retrieval: options.retrieval } : {}),
      ...(options.officeSchedules
        ? { officeSchedules: options.officeSchedules }
        : {}),
      ...(v2
        ? {
            modelSelection: {
              modelServiceId: selection.modelServiceId,
              modelEntryId: selection.modelEntryId,
              serviceRevision: selection.serviceRevision,
              effort: selection.effort,
            },
          }
        : {}),
      ...(options.calculation ? { calculation: options.calculation } : {}),
      ...(options.calculation
        ? { office: new AgentOfficeService(options.calculation) }
        : {}),
      ...(options.repository ? { repository: options.repository } : {}),
      ...(options.documents ? { documents: options.documents } : {}),
      // Resource ceiling only. Token capacity is measured on the complete wire envelope.
      contextMaxCharacters: 4_000_000,
      bindContextFrame: (scopeId, prompt) =>
        model.bindContextFrame(
          createHash('sha256')
            .update(budgetKey + ':' + scopeId)
            .digest('hex'),
          prompt,
        ),
      inspectContextBudget: (messages, tools) =>
        model.inspectBudget(messages, tools),
      agentWeb: new AgentWebService(db, options.searchEndpoint ?? null),
      modelRetryPolicy: { maxRetries: 5, ...options.modelRetryPolicy },
      externalServices: {
        connections: externalMcp,
        invocations: new ExternalMcpInvocations(db, externalMcp),
      },
      // Wire-format support permits the tool loop; this is not a supplier capability verification.
      toolCalling: v2 ? true : selection.capabilities.toolCalling,
      businessServices: {
        testConfiguration,
        plans,
        apiExecution,
        schedules,
        auxiliary: new AuxiliaryService(
          db,
          configuration,
          broker,
          options.fileReader,
        ),
      },
    });
    return {
      executionOrigin: 'liveProvider',
      run: async (owner, input) => {
        activeInput = input;
        try {
          return await host.run(owner, {
            ...input,
            beforeModelCall: async (intentId, attempt) => {
              await input.beforeModelCall(intentId, attempt);
              activeIntentId = intentId;
            },
          });
        } finally {
          activeInput = undefined;
          activeIntentId = null;
        }
      },
      dispose: () => model.dispose(),
    };
  };
}
