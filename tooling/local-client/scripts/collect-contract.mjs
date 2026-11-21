import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';

const compiled = process.argv[2];
const artifactVersion = process.argv[3];
assert.match(artifactVersion ?? '', /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/);
const fromBuild = (path) => import(pathToFileURL(resolve(compiled, path)).href);

function unavailable() {
  throw Error('Contract collection cannot access a business dependency.');
}

globalThis.fetch = unavailable;
const { createOfficialMcpServer, OFFICIAL_MCP_PROTOCOL_VERSION } =
  await fromBuild('apps/api/src/mcp.js');
const { fileResourceCapabilitiesSchema } = await fromBuild(
  'packages/contracts/src/file-resources.js',
);
const { knowledgeExportSelectionSchema } = await fromBuild(
  'packages/contracts/src/knowledge.js',
);

const dependency = new Proxy({}, { get: unavailable });
const handler = createMcpHandler(
  () =>
    createOfficialMcpServer(
      dependency,
      { entrypoint: 'official-mcp', requestId: 'contract-collection' },
      {
        auxiliary: { requirementNameAdmission: () => unavailable },
        files: dependency,
        schedules: dependency,
        testConfiguration: dependency,
        plans: dependency,
        apiExecution: dependency,
      },
    ),
  { legacy: 'reject', responseMode: 'auto', onerror: unavailable },
);

const toolSchema = z.object({
  name: z.string().regex(/^ath_[a-z0-9_]+$/),
  inputSchema: z.record(z.string(), z.json()),
});
const endpoint = new URL('http://contract-collection.invalid/mcp');
const client = new Client(
  { name: 'AITestHub contract collection', version: artifactVersion },
  {
    versionNegotiation: {
      mode: { pin: OFFICIAL_MCP_PROTOCOL_VERSION },
      probe: { maxRetries: 0 },
    },
    inputRequired: { autoFulfill: false },
  },
);
try {
  // The production serializer projects the registered tool schemas. No tool is dispatched.
  await client.connect(
    new StreamableHTTPClientTransport(endpoint, {
      async fetch(input, init) {
        const request = new Request(input, init);
        assert.equal(request.url, endpoint.href);
        assert.equal(request.method, 'POST');
        assert(
          ['server/discover', 'tools/list'].includes(
            (await request.clone().json()).method,
          ),
        );
        return handler.fetch(request);
      },
    }),
  );
  const tools = [];
  const cursors = new Set();
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...z.array(toolSchema).parse(page.tools));
    cursor = page.nextCursor;
    if (cursor) {
      assert(!cursors.has(cursor), 'Repeated official tool cursor.');
      cursors.add(cursor);
    }
  } while (cursor);
  assert(tools.length > 0, 'Empty official tool contract.');
  assert.equal(
    new Set(tools.map((tool) => tool.name)).size,
    tools.length,
    'Repeated official tool name.',
  );
  tools.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const options = {
    target: 'draft-2020-12',
    unrepresentable: 'throw',
    io: 'input',
  };
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 'ath.local-sdk-contract.v1',
      protocolVersion: OFFICIAL_MCP_PROTOCOL_VERSION,
      artifactVersion,
      tools,
      components: {
        'file-resources.fileResourceCapabilitiesSchema': z.toJSONSchema(
          fileResourceCapabilitiesSchema,
          options,
        ),
        'knowledge.knowledgeExportSelectionSchema': z.toJSONSchema(
          knowledgeExportSelectionSchema,
          options,
        ),
      },
    }) + '\n',
  );
} finally {
  await Promise.all([client.close(), handler.close()]);
}
