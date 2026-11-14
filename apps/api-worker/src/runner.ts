import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  workerRunPackageSchema,
  type JsonValue,
  type RuntimeVariables,
  type SafeResponse,
} from '../../../packages/contracts/src/api-execution.js';
import {
  apiRequestStepSchema,
  assertionSchema,
} from '../../../packages/contracts/src/domain.js';
import {
  evaluateAssertions,
  extractVariables,
  nonEmpty,
  readPath,
  type RawObservation,
} from '../../../packages/application/src/api-execution/expressions.js';
import {
  redact,
  redactWithPaths,
} from '../../../packages/application/src/api-execution/redaction.js';
import { runIsolatedScript, ScriptExecutionError } from './script-runtime.js';
import { evaluateRegex } from './regex-runtime.js';
import { performTransport, type RawTransportResponse } from './transport.js';
import { WorkerClient, WorkerProtocolError } from './client.js';

const permitSchema = z.discriminatedUnion('send', [
  z.object({
    send: z.literal(true),
    intentId: z.uuid(),
    transport: z.unknown(),
    protectedValues: z.array(z.string()),
    assertions: z.array(assertionSchema).optional(),
    authExtractor: z
      .strictObject({
        source: z.enum(['json', 'header', 'body']),
        path: z.string(),
      })
      .optional(),
  }),
  z.object({
    send: z.literal(false),
    state: z.string(),
    reason: z.string().optional(),
  }),
]);
const httpSchema = z.strictObject({
  type: z.literal('http'),
  url: z.url(),
  method: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.string().nullable(),
  timeoutMs: z.number().int().min(1).max(120000),
});
const sqlSchema = z.strictObject({
  type: z.literal('sql'),
  driver: z.enum(['postgresql', 'mysql']),
  host: z.string(),
  port: z.number().int(),
  database: z.string(),
  tls: z.boolean(),
  username: z.string(),
  password: z.string(),
  statement: z.string(),
  values: z.array(z.union([z.string(), z.number(), z.boolean()])),
  timeoutMs: z.number().int().min(1).max(120000),
});
const transportSchema = z.discriminatedUnion('type', [httpSchema, sqlSchema]);
const receiptSchema = z.object({
  recorded: z.boolean(),
  extractions: z.record(z.string(), z.json()),
  protectedValues: z.array(z.string()).optional(),
});
type Assertion = z.infer<typeof assertionSchema>;
const pointer = (value: string) =>
  value.replace(/~/g, '~0').replace(/\//g, '~1');
function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key] ?? null)}`)
    .join(',')}}`;
}
function stableCode(error: unknown): string {
  return error instanceof ScriptExecutionError
    ? error.code
    : error instanceof WorkerProtocolError
      ? error.code
      : error instanceof Error &&
          /^REGEX_ASSERTION_[A-Z_]+$/.test(error.message)
        ? error.message
        : 'STEP_EXECUTION_ERROR';
}
function safeResponse(
  raw: RawTransportResponse,
  values: string[],
  authentication = false,
): SafeResponse {
  const filtered = redactWithPaths(
    { headers: raw.headers, body: raw.body },
    values,
  ).value;
  const parsed = z
    .strictObject({ headers: z.record(z.string(), z.string()), body: z.json() })
    .parse(filtered);
  return {
    status: raw.status,
    headers: authentication ? {} : parsed.headers,
    body: authentication ? '[authentication response withheld]' : parsed.body,
    elapsedMs: raw.elapsedMs,
    errorCode: raw.errorCode,
    redactionVersion: 'ath.api-redaction.v1',
  };
}
function scriptRequest(step: z.infer<typeof apiRequestStepSchema>): JsonValue {
  return {
    method: step.method,
    url: step.url,
    query: Object.fromEntries(
      step.query.map((entry) => [entry.name, entry.value]),
    ),
    headers: Object.fromEntries(
      step.headers.map((entry) => [entry.name, entry.value]),
    ),
    body: step.body,
  };
}
async function assertionsFor(
  assertions: Assertion[],
  response: RawObservation,
  variables: RuntimeVariables,
) {
  const results = [];
  for (const assertion of assertions) {
    if (assertion.operator !== 'matches') {
      results.push(...evaluateAssertions([assertion], response, variables));
      continue;
    }
    let actual: unknown;
    if (assertion.source === 'status') actual = response.status;
    else if (assertion.source === 'body')
      actual =
        typeof response.body === 'string'
          ? response.body
          : JSON.stringify(response.body);
    else if (assertion.source === 'header')
      actual = response.headers[(assertion.path ?? '').toLowerCase()];
    else if (assertion.source === 'variable')
      actual = readPath(
        { case: variables.case, extract: variables.extract },
        assertion.path ?? '',
      );
    else actual = readPath(response.body, assertion.path ?? '');
    const passed =
      typeof actual === 'string' &&
      typeof assertion.expected === 'string' &&
      (await evaluateRegex(assertion.expected, actual));
    results.push({
      passed,
      message: `断言${assertion.id}${passed ? '通过' : '未满足'}。`,
    });
  }
  return results;
}
export async function runAssigned(
  client: WorkerClient,
  grant: string,
  options: { leaseMs?: number; signal?: AbortSignal } = {},
) {
  let heartbeatFailed = false;
  let heartbeatBusy = false;
  const heartbeat = setInterval(
    () => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      void client
        .heartbeat(grant)
        .catch(() => {
          heartbeatFailed = true;
        })
        .finally(() => {
          heartbeatBusy = false;
        });
    },
    Math.max(20, Math.min(5000, Math.floor((options.leaseMs ?? 30000) / 3))),
  );
  const assertLive = () => {
    if (heartbeatFailed || options.signal?.aborted)
      throw new WorkerProtocolError('WORKER_OWNERSHIP_UNCERTAIN');
  };
  try {
    const work = workerRunPackageSchema.parse(await client.load(grant));
    const { snapshotDigest: _snapshotDigest, ...scopeWithoutDigest } =
      work.scope;
    if (
      createHash('sha256')
        .update(canonical(z.json().parse(scopeWithoutDigest)))
        .digest('hex') !== work.snapshotDigest
    )
      throw new WorkerProtocolError('SCOPE_DIGEST_MISMATCH');
    for (const item of work.items)
      if (
        canonical(z.json().parse(item.scopeItem)) !==
        canonical(
          z
            .json()
            .parse(
              work.scope.items.find(
                (scopeItem) => scopeItem.runItemId === item.scopeItem.runItemId,
              ),
            ),
        )
      )
        throw new WorkerProtocolError('SCOPE_DIGEST_MISMATCH');
    for (const entry of work.items) {
      assertLive();
      const began = z
        .object({ begin: z.boolean() })
        .parse(await client.begin(grant, entry.scopeItem.runItemId));
      if (!began.begin) break;
      const content = entry.scopeItem.content;
      const variables: RuntimeVariables = {
        case: structuredClone(content.variables),
        extract: {},
      };
      const rawExtracts: Record<string, JsonValue> = {};
      const protectedValues = new Set<string>();
      const extractPaths = new Map<string, string[]>();
      let businessFailed = false;
      let responseAssertionCount = 0;
      let businessReason = '已审业务断言满足。';
      const mergeVariables = (patch: Record<string, JsonValue>) => {
        for (const [name, value] of Object.entries(patch)) {
          if (['__proto__', 'constructor', 'prototype'].includes(name))
            throw new WorkerProtocolError('SCRIPT_RESULT_INVALID');
          if (
            redactWithPaths(value, [...protectedValues]).protectedPaths.length
          )
            throw new WorkerProtocolError('SCRIPT_OUTPUT_PROTECTED');
          variables.case[name] = value;
        }
      };
      const scripts = async (
        script: string | undefined,
        step: z.infer<typeof apiRequestStepSchema>,
        response?: RawTransportResponse,
        tentative: Record<string, JsonValue> = {},
      ) => {
        if (!script) return { variables: {}, assertions: [] };
        const extractionShadow = { ...variables.extract, ...tentative };
        const original: JsonValue = {
          env: entry.environment,
          case: variables.case,
          extract: extractionShadow,
          request: scriptRequest(step),
          ...(response
            ? {
                response: {
                  status: response.status,
                  headers: response.headers,
                  body: response.body,
                },
              }
            : {}),
        };
        const safe = redactWithPaths(original, [...protectedValues]);
        const inherited = [...extractPaths].flatMap(([name, paths]) =>
          paths.map((path) => `/extract/${pointer(name)}${path}`),
        );
        return runIsolatedScript(script, safe.value, {
          protectedPaths: [...new Set([...safe.protectedPaths, ...inherited])],
          ...(options.signal ? { signal: options.signal } : {}),
        });
      };
      const ensureAuth = async (
        phase: 'business' | 'cleanupHttp',
        stepId: string,
      ) => {
        const authentication = entry.auth[`${phase}:${stepId}`];
        if (authentication?.mode !== 'login') return true;
        const permit = permitSchema.parse(
          await client.authorize(grant, {
            runItemId: entry.scopeItem.runItemId,
            phase: 'auth',
            stepId: authentication.cacheKey,
            forPhase: phase,
            forStepId: stepId,
            variables,
          }),
        );
        if (!permit.send) return permit.state === 'completed';
        for (const value of permit.protectedValues) protectedValues.add(value);
        assertLive();
        const transport = transportSchema.parse(permit.transport);
        const raw = await performTransport(transport, options.signal);
        let authToken: string | undefined;
        if (
          raw.errorCode === null &&
          raw.status !== null &&
          raw.status >= 200 &&
          raw.status < 300 &&
          permit.authExtractor
        ) {
          const definition = permit.authExtractor;
          const value =
            definition.source === 'json'
              ? readPath(raw.body, definition.path)
              : definition.source === 'header'
                ? raw.headers[definition.path.toLowerCase()]
                : typeof raw.body === 'string'
                  ? raw.body
                  : undefined;
          if (
            typeof value === 'string' &&
            value.length > 0 &&
            value.length <= 16384
          ) {
            authToken = value;
            protectedValues.add(value);
          }
        }
        const recorded = receiptSchema.parse(
          await client.completeAttempt(grant, {
            intentId: permit.intentId,
            response: safeResponse(raw, [...protectedValues], true),
            passed: Boolean(authToken),
            reason: authToken
              ? '登录材料已按指定路径取得。'
              : '登录失败或指定Token未取得；不自动重新登录。',
            sideEffectCertainty: raw.sideEffectCertainty,
            extractions: {},
            assertions: [],
            ...(authToken ? { authToken } : {}),
          }),
        );
        for (const value of recorded.protectedValues ?? [])
          protectedValues.add(value);
        return Boolean(authToken);
      };
      const execute = async (
        phase: 'business' | 'cleanupHttp' | 'cleanupSql',
        stepId: string,
        step?: z.infer<typeof apiRequestStepSchema>,
      ) => {
        assertLive();
        if (step) {
          const pre = await scripts(step.preScript, step);
          mergeVariables(pre.variables);
          if (pre.assertions.some((assertion) => !assertion.passed))
            throw new WorkerProtocolError('PRE_SCRIPT_ASSERTION_FAILED');
          if (
            !(await ensureAuth(
              phase === 'business' ? 'business' : 'cleanupHttp',
              stepId,
            ))
          )
            throw new WorkerProtocolError('AUTHENTICATION_FAILED');
        }
        const permit = permitSchema.parse(
          await client.authorize(grant, {
            runItemId: entry.scopeItem.runItemId,
            phase,
            stepId,
            variables,
          }),
        );
        if (!permit.send) {
          if (phase !== 'business' && permit.state === 'skipped')
            return { passed: false, skipped: true };
          throw new WorkerProtocolError(
            permit.state === 'intent' || permit.state === 'completed'
              ? 'SEND_PERMIT_ALREADY_CONSUMED'
              : 'SEND_NOT_AUTHORIZED',
          );
        }
        for (const value of permit.protectedValues) protectedValues.add(value);
        assertLive();
        const raw = await performTransport(
          transportSchema.parse(permit.transport),
          options.signal,
        );
        let passed = raw.errorCode === null;
        let reason = passed
          ? '请求返回并完成校验。'
          : '响应不可用，副作用可能未知，不重发。';
        let assertions: { passed: boolean; message: string }[] = [];
        const extracted: Record<string, JsonValue> = {};
        if (step && raw.errorCode === null) {
          try {
            assertions = await assertionsFor(
              permit.assertions ?? step.assertions,
              raw,
              {
                case: variables.case,
                extract: rawExtracts,
              },
            );
            if (assertions.some((assertion) => !assertion.passed)) {
              passed = false;
              reason = '实际响应未满足已审断言。';
            }
          } catch (error: unknown) {
            passed = false;
            reason = stableCode(error);
          }
          for (const extractor of step.extractors) {
            try {
              Object.assign(extracted, extractVariables([extractor], raw));
            } catch {
              passed = false;
              reason = 'REQUIRED_EXTRACTION_MISSING';
            }
          }
          const responseProtection = redactWithPaths(
            { headers: raw.headers, body: raw.body },
            [...protectedValues],
          );
          for (const value of responseProtection.protectedValues())
            protectedValues.add(value);
          const tentative: Record<string, JsonValue> = {};
          for (const [name, value] of Object.entries(extracted)) {
            rawExtracts[name] = value;
            const extractor = step.extractors.find(
              (entry) => entry.name === name,
            );
            const protection = redactWithPaths(
              value,
              [...protectedValues],
              `${name}.${extractor?.path ?? ''}`,
            );
            tentative[name] = protection.value;
            extractPaths.set(name, protection.protectedPaths);
            for (const value of protection.protectedValues())
              protectedValues.add(value);
          }
          try {
            const post = await scripts(step.postScript, step, raw, tentative);
            mergeVariables(post.variables);
            assertions.push(...post.assertions);
            if (post.assertions.some((assertion) => !assertion.passed)) {
              passed = false;
              reason = '复杂脚本断言未满足。';
            }
          } catch (error: unknown) {
            passed = false;
            reason = stableCode(error);
            assertions.push({ passed: false, message: reason });
          }
        }
        assertions = assertions.map((assertion) => ({
          passed: assertion.passed,
          message: String(
            redact(assertion.message, [...protectedValues]),
          ).slice(0, 200),
        }));
        if (phase === 'business') responseAssertionCount += assertions.length;
        const receipt = receiptSchema.parse(
          await client.completeAttempt(grant, {
            intentId: permit.intentId,
            response: safeResponse(raw, [...protectedValues]),
            passed,
            reason,
            sideEffectCertainty: raw.sideEffectCertainty,
            extractions: extracted,
            assertions,
          }),
        );
        Object.assign(variables.extract, receipt.extractions);
        for (const value of receipt.protectedValues ?? [])
          protectedValues.add(value);
        return { passed, skipped: false };
      };
      for (const step of content.steps) {
        try {
          const result = await execute('business', step.stepId, step);
          if (!result.passed) {
            businessFailed = true;
            businessReason = '业务请求/提取/断言未满足；后续业务步骤未发送。';
            break;
          }
        } catch (error: unknown) {
          if (
            error instanceof WorkerProtocolError &&
            [
              'CONTROL_UNAVAILABLE',
              'CONTROL_RESPONSE_INVALID',
              'WORKER_OWNERSHIP_UNCERTAIN',
              'SEND_PERMIT_ALREADY_CONSUMED',
            ].includes(error.code)
          )
            throw error;
          businessFailed = true;
          businessReason = stableCode(error);
          await client.localFailure(grant, {
            runItemId: entry.scopeItem.runItemId,
            phase: 'business',
            stepId: step.stepId,
            code: businessReason,
            reason: businessReason,
          });
          break;
        }
      }
      if (!businessFailed && responseAssertionCount === 0) {
        businessFailed = true;
        businessReason = 'ASSERTION_MISSING';
      }
      if (
        content.cleanup.mode !== 'none' &&
        (content.cleanup.mode === 'always' || !businessFailed)
      ) {
        for (const cleanup of content.cleanup.steps) {
          try {
            if (
              cleanup.requiredTargets.some(
                (path) =>
                  !nonEmpty(
                    readPath(
                      {
                        env: entry.environment,
                        case: variables.case,
                        extract: variables.extract,
                      },
                      path,
                    ),
                  ),
              )
            ) {
              await client.localFailure(grant, {
                runItemId: entry.scopeItem.runItemId,
                phase: cleanup.type === 'sql' ? 'cleanupSql' : 'cleanupHttp',
                stepId: cleanup.cleanupStepId,
                code: 'MISSING_CLEANUP_TARGET',
                reason: '必要清理目标为空，未发送。',
                skipped: true,
              });
              continue;
            }
            await execute(
              cleanup.type === 'sql' ? 'cleanupSql' : 'cleanupHttp',
              cleanup.cleanupStepId,
              cleanup.type === 'http' ? cleanup.request : undefined,
            );
          } catch (error: unknown) {
            if (
              error instanceof WorkerProtocolError &&
              [
                'CONTROL_UNAVAILABLE',
                'CONTROL_RESPONSE_INVALID',
                'WORKER_OWNERSHIP_UNCERTAIN',
                'SEND_PERMIT_ALREADY_CONSUMED',
              ].includes(error.code)
            )
              throw error;
            await client.localFailure(grant, {
              runItemId: entry.scopeItem.runItemId,
              phase: cleanup.type === 'sql' ? 'cleanupSql' : 'cleanupHttp',
              stepId: cleanup.cleanupStepId,
              code: stableCode(error),
              reason: stableCode(error),
              skipped: false,
            });
          }
        }
      }
      await client.completeCase(grant, {
        runItemId: entry.scopeItem.runItemId,
        outcome: businessFailed ? 'failed' : 'passed',
        reason: businessReason,
      });
    }
    return await client.finish(grant);
  } catch (error: unknown) {
    await client.abandon(grant).catch(() => {});
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}
