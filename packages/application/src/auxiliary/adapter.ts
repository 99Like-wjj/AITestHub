import { createNativeModelAdapter } from '../../../model-adapters/src/index.js';
import type { ConfigurationService } from '../configuration/service.js';
import type { SecretBroker } from '../configuration/secrets.js';
import type { Database } from '../../../persistence/src/database.js';
import type { AuxiliaryModelFactory } from './worker.js';
import { resolveAcceptedAuxiliaryModel } from './model-snapshot.js';
/** One native request, no tools/retry/fallback. Only this code receives the broker credential. */
export function createAuxiliaryModelFactory(
  _db: Database,
  configuration: ConfigurationService,
  broker: SecretBroker,
): AuxiliaryModelFactory {
  const factory = async (...args: Parameters<AuxiliaryModelFactory>) => {
    const [model, actor, purpose, authorize, onDispatch] = args;
    const selected = await resolveAcceptedAuxiliaryModel(
      configuration,
      actor,
      model,
    );
    const protocol =
      'schemaVersion' in model ? model.protocol : 'chatCompletions';
    const native = createNativeModelAdapter(protocol, {
      baseUrl: model.baseUrl,
      model: model.modelId,
      authScheme: 'schemaVersion' in model ? model.authScheme : 'bearer',
      allowLocalHttp: new URL(model.baseUrl).protocol === 'http:',
      timeoutMs: 60000,
      onDispatch: (attempt) => onDispatch(attempt.clientRequestId),
      credential: async () => {
        await authorize();
        const current = await resolveAcceptedAuxiliaryModel(
          configuration,
          actor,
          model,
        );
        return broker.resolve(current.credentialRef, {
          ownerScope: 'platform',
          ownerId: current.modelServiceId,
          purpose: 'model-api-key',
        });
      },
    });
    return {
      maxTokens: Math.min(
        purpose === 'alias' ? 512 : purpose === 'issueAdvice' ? 4096 : 2048,
        selected.maxOutput ?? 4096,
      ),
      complete: native.complete.bind(native),
      release: native.release.bind(native),
    };
  };
  return Object.assign(factory, { executionOrigin: 'liveProvider' as const });
}
