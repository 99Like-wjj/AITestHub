import { z } from 'zod';
import {
commandIdSchema,
idSchema,
rowVersionSchema,
titleSchema,
} from './base.js';

export const configurationKindSchema = z.enum([
  'environment',
  'purpose',
  'account',
  'authProfile',
  'binding',
  'databaseConnection',
]);
const label = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/);
const text = z.string().max(10_000);
const endpoint = z.url().refine((value) => {
  const url = new URL(value);
  return (
    ['http:', 'https:'].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.hash &&
    !url.search
  );
}, '服务地址须为无凭据、无查询参数的HTTP(S)地址');
const base = { name: titleSchema, description: text, active: z.boolean() };
const transportValue = z
  .string()
  .max(100_000)
  .refine((value) => !/[\r\n\0]/.test(value));
const destination = z.strictObject({
  location: z.enum(['header', 'cookie', 'query']),
  name: label,
  prefix: z.string().max(200),
});
export const authenticationDefinitionSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('token'), destination }),
  z.strictObject({
    mode: z.literal('login'),
    baseUrlName: label,
    path: z.string().max(4000).startsWith('/'),
    method: z.enum(['GET', 'POST']),
    headers: z.record(label, transportValue),
    bodyTemplate: z.json(),
    extractor: z.strictObject({
      source: z.enum(['json', 'header', 'body']),
      path: z.string().max(2000),
    }),
    destination,
  }),
]);
export const testConfigurationContentSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('environment'),
    ...base,
    baseUrls: z
      .record(label, endpoint)
      .refine((urls) => Object.keys(urls).length > 0, '至少一个服务地址'),
    variables: z.record(label, z.string().max(10_000)),
  }),
  z.strictObject({ kind: z.literal('purpose'), ...base }),
  z.strictObject({ kind: z.literal('account'), ...base }),
  z.strictObject({
    kind: z.literal('authProfile'),
    ...base,
    authentication: authenticationDefinitionSchema,
  }),
  z.strictObject({
    kind: z.literal('binding'),
    ...base,
    environmentId: idSchema,
    purposeId: idSchema,
    accountId: idSchema,
    authProfileId: idSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('databaseConnection'),
    ...base,
    environmentId: idSchema,
    driver: z.enum(['postgresql', 'mysql']),
    host: z
      .string()
      .min(1)
      .max(253)
      .regex(/^[A-Za-z0-9_.:-]+$/),
    port: z.number().int().min(1).max(65535),
    database: z.string().min(1).max(128),
    tls: z.boolean(),
  }),
]);
export const saveTestConfigurationInputSchema = z.strictObject({
  commandId: commandIdSchema,
  rowVersion: rowVersionSchema,
  content: testConfigurationContentSchema,
});
export const projectCredentialInputSchema = z.strictObject({
  commandId: commandIdSchema,
  rowVersion: rowVersionSchema.min(1),
  credential: z.union([
    z.strictObject({
      username: z.string().min(1).max(512),
      password: z.string().min(1).max(8192),
    }),
    z.strictObject({ value: z.string().min(1).max(8192) }),
  ]),
});
export type TestConfigurationContent = z.infer<
  typeof testConfigurationContentSchema
>;
export type ConfigurationKind = z.infer<typeof configurationKindSchema>;
const viewBase = {
  id: idSchema,
  projectId: idSchema,
  rowVersion: rowVersionSchema.min(1),
  revisionId: idSchema,
};
export const testConfigurationDtoSchema = z.strictObject({
  ...viewBase,
  hasCredential: z.boolean(),
  content: testConfigurationContentSchema,
});
export const testConfigurationViewSchema = z.union([
  testConfigurationDtoSchema,
  z.strictObject({
    ...viewBase,
    content: z.strictObject({ kind: z.literal('environment'), ...base }),
  }),
  z.strictObject({
    ...viewBase,
    content: z.strictObject({
      kind: z.literal('databaseConnection'),
      name: titleSchema,
      driver: z.enum(['postgresql', 'mysql']),
      environmentId: idSchema,
    }),
  }),
]);
export const testConfigurationListSchema = z.strictObject({
  configurations: z.array(testConfigurationViewSchema),
});
export const testConfigurationReceiptSchema = z.strictObject({
  configuration: testConfigurationDtoSchema,
});
export type TestConfigurationView = z.infer<typeof testConfigurationViewSchema>;
