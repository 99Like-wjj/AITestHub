import { createDatabaseFromEnvironment } from '../../../packages/persistence/src/config.js';
import { createSandboxClientFromEnvironment } from '../../../packages/agent-runtime/src/environment.js';
import { AgentWorkspaceService } from '../../../packages/application/src/agent-workspace/service.js';
import { AgentCalculationService } from '../../../packages/application/src/agent-calculation/service.js';
import { AgentDocumentsService } from '../../../packages/application/src/agent-documents/service.js';
import { SandboxDocumentParser } from '../../../packages/application/src/agent-documents/sandbox-parser.js';
import { ConversationsService } from '../../../packages/application/src/conversations/service.js';
import { createAgentScheduleService } from '../../../packages/application/src/agent-schedules/factory.js';
import { DomainError } from '../../../packages/application/src/errors.js';
import { AgentRepositoryService } from '../../../packages/application/src/agent-repository/service.js';
import { createSemanticEmbeddingFromEnvironment } from '../../../packages/agent-embedding/src/client.js';
import { AgentRetrievalService } from '../../../packages/application/src/agent-retrieval/service.js';
import { MaintenanceService } from '../../../packages/application/src/recovery/maintenance.js';
import { runOfficeBackgroundWork } from './background-maintenance.js';
import { createStorageFromEnvironment } from '../../../packages/storage/src/s3.js';
import { FilesService } from '../../../packages/application/src/files/service.js';
import { SecretBroker } from '../../../packages/application/src/configuration/secrets.js';
import { ConfigurationService } from '../../../packages/application/src/configuration/service.js';
import { ConversationFileReader } from '../../../packages/application/src/conversations/file-reader.js';
import {
  AiTasksService,
  AiTaskWorker,
} from '../../../packages/application/src/conversations/tasks.js';
import { createConversationRunnerFactory } from './runner-factory.js';
import { disableExternalTracing } from './host.js';
import { AuxiliaryService } from '../../../packages/application/src/auxiliary/service.js';
import { AuxiliaryWorker } from '../../../packages/application/src/auxiliary/worker.js';
import { createAuxiliaryModelFactory } from '../../../packages/application/src/auxiliary/adapter.js';
import { ControlJournal } from '../../../packages/application/src/recovery/control-journal.js';
import { AiTaskAdmission } from '../../../packages/application/src/resource-concurrency/worker-admission.js';
import { assertModelProtocolCheckpoint } from '../../../packages/application/src/configuration/model-checkpoint.js';

async function main() {
  disableExternalTracing();
  const database = await createDatabaseFromEnvironment();
  const controls = await ControlJournal.fromEnvironment(database);
  await controls.initialize();
  await assertModelProtocolCheckpoint(database, controls);
  await database.query(
    'SELECT execution_origin,request_count,dispatch_certainty,logical_call_id,attempt_no FROM app.model_call_ledger LIMIT 0',
  );
  await database.query('SELECT id FROM app.ai_model_attempts LIMIT 0');
  const storage = await createStorageFromEnvironment();
  const broker = await SecretBroker.fromEnvironment(database);
  const configuration = new ConfigurationService(database, broker);
  const files = new FilesService(database, storage);
  const sandbox = await createSandboxClientFromEnvironment();
  const documents = new AgentDocumentsService(
    files,
    sandbox ? new SandboxDocumentParser(sandbox) : undefined,
  );
  const calculation = sandbox
    ? new AgentCalculationService(
        database,
        new AgentWorkspaceService(database, files),
        sandbox,
      )
    : undefined;
  const fileReader = new ConversationFileReader(files, documents);
  const repository = sandbox
    ? new AgentRepositoryService(files, sandbox)
    : undefined;
  const tasks = new AiTasksService(database, configuration, fileReader);
  const embedding = await createSemanticEmbeddingFromEnvironment();
  const retrieval = embedding
    ? new AgentRetrievalService(
        database,
        files,
        documents,
        embedding,
        tasks.references,
      )
    : undefined;
  const scheduledConversations = new ConversationsService(
    database,
    configuration,
    fileReader,
    {
      record: async () => {
        throw new DomainError('FORBIDDEN', '定时执行端不开放会话删除。', 403);
      },
    },
  );
  const officeSchedules = createAgentScheduleService(
    database,
    scheduledConversations,
    tasks,
  );
  const admission = new AiTaskAdmission();
  const auxiliaryService = new AuxiliaryService(
    database,
    configuration,
    broker,
    fileReader,
  );
  const worker = new AiTaskWorker(
    tasks,
    createConversationRunnerFactory(database, configuration, broker, {
      fileReader,
      officeSchedules,
      ...(retrieval ? { retrieval } : {}),
      ...(repository ? { repository } : {}),
      documents,
      ...(calculation ? { calculation } : {}),
      ...(process.env.AITESTHUB_SEARCH_ENDPOINT
        ? { searchEndpoint: process.env.AITESTHUB_SEARCH_ENDPOINT }
        : {}),
    }),
    admission,
    (tx, ownerId, taskId) =>
      auxiliaryService.enqueueConversationTitleInTransaction(
        tx,
        ownerId,
        taskId,
      ),
  );
  const auxiliary = new AuxiliaryWorker(
    auxiliaryService,
    createAuxiliaryModelFactory(database, configuration, broker),
    admission,
  );
  let auxiliaryNext = false;
  const backgroundMaintenance = new MaintenanceService(database);
  const tick = async () => {
    const scheduleWorked = await runOfficeBackgroundWork(
      backgroundMaintenance,
      async () => {
        return officeSchedules.tick();
      },
    );
    auxiliaryNext = !auxiliaryNext;
    const first = auxiliaryNext ? auxiliary : worker,
      second = auxiliaryNext ? worker : auxiliary;
    if (await first.tick()) return true;
    return (await second.tick()) || scheduleWorked;
  };
  let stopping = false;
  process.once('SIGINT', () => {
    stopping = true;
    worker.requestStop();
    auxiliary.requestStop();
  });
  process.once('SIGTERM', () => {
    stopping = true;
    worker.requestStop();
    auxiliary.requestStop();
  });
  await worker.heartbeat();
  const recovered = await worker.recoverInterrupted();
  const recoveredAuxiliary = await auxiliary.recoverExpired();
  process.stdout.write(
    `AITestHub AI worker ready; interrupted chat tasks=${recovered}, auxiliary tasks=${recoveredAuxiliary}; no automatic replay; no inbound port.\n`,
  );
  const heartbeat = setInterval(() => {
    void worker.heartbeat().catch(() => {
      process.stderr.write('AI worker heartbeat persistence unavailable.\n');
    });
  }, 5_000);
  try {
    while (!stopping) {
      // Two local ticks; the DB admission mutex caps chat+auxiliary across processes.
      const work = await Promise.allSettled([tick(), tick()]);
      if (work.some((outcome) => outcome.status === 'rejected'))
        process.stderr.write(
          'AI worker task persistence failed; inspect safe task status.\n',
        );
      if (
        work.some((outcome) => outcome.status === 'rejected') ||
        work.every(
          (outcome) => outcome.status === 'fulfilled' && !outcome.value,
        )
      )
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
  } finally {
    clearInterval(heartbeat);
    await worker.stop();
    await auxiliary.stop();
    storage.close();
    await database.close();
  }
}

main().catch(() => {
  process.stderr.write(
    'AI worker could not start; inspect required private configuration and migrations.\n',
  );
  process.exitCode = 1;
});
