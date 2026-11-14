import type { FileChannelHost } from './files.js';
import { PlatformFileChannel } from './files.js';
import type { ToolPort } from './ports.js';
import { OfficialResultPort } from './result.js';
import {
  ActorWorkspace,
  platformOrigin,
  type HostBinding,
} from './workspace.js';
import { createSdkToolPort, type SdkRequestOnce } from './sdk.js';
import { assertSafe, assertMcpArgumentBudget } from './safety.js';
import { validateToolInput } from './contracts.js';
import { LocalClientError } from './errors.js';

type ToolHost =
  | { nativeTool: ToolPort; sdkClient?: never }
  | { sdkClient: SdkRequestOnce; nativeTool?: never };
export type TrustedHostConfig = HostBinding &
  ToolHost & {
    getBearerToken: FileChannelHost['getBearerToken'];
    fetch?: typeof fetch;
    requestTimeoutMs?: number;
    fileTimeoutMs?: number;
    maximumDownloadBytes?: number;
  };
/** Code-only host constructor. Never deserialize these identity/credential functions from model input. */
export async function createTrustedHost(config: TrustedHostConfig) {
  if (
    typeof config.getBearerToken !== 'function' ||
    Boolean(config.nativeTool) === Boolean(config.sdkClient) ||
    (config.nativeTool && typeof config.nativeTool.callTool !== 'function') ||
    (config.sdkClient && typeof config.sdkClient.request !== 'function')
  )
    throw new LocalClientError(
      'INVALID_HOST_CONFIG',
      'notDispatched',
      '可信host必须注入唯一已配置工具端口和私有凭据供应函数。',
    );
  const workspace = await ActorWorkspace.create(config),
    result = new OfficialResultPort();
  let tool: ToolPort;
  if (config.nativeTool) {
    const native = config.nativeTool;
    tool = {
      async callTool(name, args) {
        platformOrigin(workspace.origin);
        assertSafe(args);
        assertMcpArgumentBudget(args);
        validateToolInput(name, args);
        let value: unknown;
        try {
          value = await native.callTool(name, structuredClone(args));
        } catch (error) {
          if (error instanceof LocalClientError) throw error;
          throw new LocalClientError(
            'NATIVE_MCP_OUTCOME_UNKNOWN',
            'unknown',
            '原生MCP没有可靠回执；不自动重发。',
          );
        }
        try {
          assertSafe(value);
        } catch {
          throw new LocalClientError(
            'UNSAFE_TOOL_RECEIPT',
            'unknown',
            '已收到不安全回执；不能推断写未发生。',
          );
        }
        return value;
      },
    };
  } else tool = createSdkToolPort(config.sdkClient, config.requestTimeoutMs);
  const files = new PlatformFileChannel({
    workspace,
    tool,
    result,
    getBearerToken: config.getBearerToken,
    ...(config.fetch ? { fetch: config.fetch } : {}),
    ...(config.fileTimeoutMs !== undefined
      ? { timeoutMs: config.fileTimeoutMs }
      : {}),
    ...(config.maximumDownloadBytes !== undefined
      ? { maximumDownloadBytes: config.maximumDownloadBytes }
      : {}),
  });
  return Object.freeze({
    tool,
    result,
    workspace,
    files,
    privateRoot: workspace.root,
    actorId: workspace.actorId,
    platformOrigin: workspace.origin,
  });
}
