import {
  NativeModelDiscovery,
  ModelDiscoveryError,
} from '../../../model-adapters/src/model-discovery.js';
import type { ModelDiscoveryPort } from './v2-service.js';
import { DomainError } from '../errors.js';

/** Trusted server composition. Discovery has its own one-shot error boundary;
 * upstream authentication never becomes the platform's Web-session 401. */
export function createModelDiscoveryPort(): ModelDiscoveryPort {
  const native = new NativeModelDiscovery({ allowLocalHttp: true });
  return {
    async discover(input) {
      try {
        return await native.discover(input);
      } catch (error) {
        if (error instanceof DomainError) throw error;
        if (error instanceof ModelDiscoveryError)
          throw new DomainError('DEPENDENCY_UNAVAILABLE', error.message, 503, {
            modelDiscoveryCode: error.code,
            upstreamHttpStatus: error.httpStatus,
            requestsSent: error.requestsSent,
            automaticRetry: false,
          });
        throw new DomainError(
          'DEPENDENCY_UNAVAILABLE',
          '模型列表读取失败；未自动重试或切换服务，可检查连接或手工添加模型。',
          503,
        );
      }
    },
  };
}
