import { z } from 'zod';
import { idSchema } from '../../../contracts/src/base.js';
import {
  apiCatalogCreateInputSchema,
  apiCatalogCloneDraftInputSchema,
  apiCatalogDiagnosticDraftInputSchema,
  apiCatalogExportInputSchema,
  apiCatalogGetInputSchema,
  apiCatalogImportApplyInputSchema,
  apiCatalogImportPreviewInputSchema,
  apiCatalogListInputSchema,
  apiCatalogMockInputSchema,
  apiCatalogOrganizeInputSchema,
  apiCatalogReviseInputSchema,
} from '../../../contracts/src/api-catalog.js';
import {
  apiAutomationArchiveInputSchema,
  apiAutomationCreateCaseInputSchema,
  apiAutomationCreateScenarioInputSchema,
  apiAutomationGetInputSchema,
  apiAutomationListInputSchema,
  apiAutomationReviseCaseInputSchema,
  apiAutomationReviseScenarioInputSchema,
  apiAutomationRevisionsInputSchema,
} from '../../../contracts/src/api-automation.js';
import {
  apiSharedScriptCreateInputSchema,
  apiSharedScriptGetInputSchema,
  apiSharedScriptListInputSchema,
  apiSharedScriptReviseInputSchema,
} from '../../../contracts/src/api-shared-scripts.js';
import type { Database } from '../../../persistence/src/database.js';
import { ApiCatalogService } from '../api-catalog/service.js';
import { ApiAutomationService } from '../assets/api-automation.js';
import type { BusinessToolRegistry } from './registry.js';
import { ApiDatabaseReadService } from '../api-execution/database-reads.js';
import { apiDatabaseReadRegisterSchema } from '../../../contracts/src/api-database-reads.js';
import { ApiSharedScriptService } from '../api-execution/shared-scripts.js';

const catalog = 'ath_api_catalog';
const automation = 'ath_api_automation';
const catalogDescription =
  '管理项目接口目录、接口定义及共享脚本修订，预览导入、查看引用、导出接口和试算 Mock。';
const automationDescription =
  '管理项目级独立单接口用例、项目场景及场景用例的草稿和归属。';

const project = { projectId: idSchema };
const operation = (op: string) => ({ op: z.literal(op), ...project });
const catalogInput = <S extends z.ZodType>(op: string, input: S) =>
  z.strictObject({ ...operation(op), input });
const catalogTarget = <S extends z.ZodType>(op: string, input: S) =>
  z.strictObject({ ...operation(op), id: idSchema, input });

export function registerApiAssetTools(
  registry: BusinessToolRegistry,
  db: Database,
) {
  const assets = new ApiCatalogService(db);
  const cases = new ApiAutomationService(db);
  const observations = new ApiDatabaseReadService(db);
  const scripts = new ApiSharedScriptService(db);
  registry.add(
    catalog,
    catalogDescription,
    'list-database-reads',
    catalogInput('list-database-reads', z.strictObject({})),
    'read',
    (actor, args) => observations.list(actor, args.projectId),
  );
  registry.add(
    catalog,
    catalogDescription,
    'register-database-read',
    catalogInput('register-database-read', apiDatabaseReadRegisterSchema),
    'write',
    (actor, args) => observations.register(actor, args.projectId, args.input),
  );
  registry.add(
    catalog,
    catalogDescription,
    'script-list',
    catalogInput('script-list', apiSharedScriptListInputSchema),
    'read',
    (actor, args) => scripts.list(actor, args.projectId, args.input),
  );
  registry.add(
    catalog,
    catalogDescription,
    'script-get',
    catalogInput('script-get', apiSharedScriptGetInputSchema),
    'read',
    (actor, args) => scripts.get(actor, args.projectId, args.input),
  );
  registry.add(
    catalog,
    catalogDescription,
    'script-create',
    catalogInput('script-create', apiSharedScriptCreateInputSchema),
    'write',
    (actor, args) => scripts.create(actor, args.projectId, args.input),
  );
  registry.add(
    catalog,
    catalogDescription,
    'script-revise',
    catalogInput('script-revise', apiSharedScriptReviseInputSchema),
    'write',
    (actor, args) => scripts.revise(actor, args.projectId, args.input),
  );
  registry.add(
    catalog,
    catalogDescription,
    'list',
    catalogInput('list', apiCatalogListInputSchema),
    'read',
    (actor, args) => assets.list(actor, args.projectId, args.input),
  );
  registry.add(
    catalog,
    catalogDescription,
    'get',
    catalogTarget('get', apiCatalogGetInputSchema),
    'read',
    (actor, args) => assets.get(actor, args.projectId, args.id, args.input),
  );
  registry.add(
    catalog,
    catalogDescription,
    'create',
    catalogInput('create', apiCatalogCreateInputSchema),
    'write',
    (actor, args) => assets.create(actor, args.projectId, args.input),
  );
  registry.add(
    catalog,
    catalogDescription,
    'preview-diagnostic',
    catalogInput('preview-diagnostic', apiCatalogDiagnosticDraftInputSchema),
    'read',
    (actor, args) =>
      assets.previewDiagnostic(actor, args.projectId, args.input),
  );
  registry.add(
    catalog,
    catalogDescription,
    'preview-clone',
    catalogInput('preview-clone', apiCatalogCloneDraftInputSchema),
    'read',
    (actor, args) => assets.previewClone(actor, args.projectId, args.input),
  );
  registry.add(
    catalog,
    catalogDescription,
    'organize',
    catalogInput('organize', apiCatalogOrganizeInputSchema),
    'write',
    (actor, args) => assets.organize(actor, args.projectId, args.input),
  );
  registry.add(
    catalog,
    catalogDescription,
    'revise',
    catalogInput('revise', apiCatalogReviseInputSchema),
    'write',
    (actor, args) => assets.revise(actor, args.projectId, args.input),
  );
  registry.add(
    catalog,
    catalogDescription,
    'preview-import',
    catalogInput('preview-import', apiCatalogImportPreviewInputSchema),
    'read',
    (actor, args) => assets.previewImport(actor, args.projectId, args.input),
  );
  registry.add(
    catalog,
    catalogDescription,
    'apply-import',
    catalogInput('apply-import', apiCatalogImportApplyInputSchema),
    'write',
    (actor, args) => assets.applyImport(actor, args.projectId, args.input),
  );
  registry.add(
    catalog,
    catalogDescription,
    'export',
    catalogTarget('export', apiCatalogExportInputSchema),
    'read',
    (actor, args) =>
      assets.exportDefinition(actor, args.projectId, args.id, args.input),
  );
  registry.add(
    catalog,
    catalogDescription,
    'preview-mock',
    catalogTarget('preview-mock', apiCatalogMockInputSchema),
    'read',
    (actor, args) =>
      assets.previewMock(actor, args.projectId, args.id, args.input),
  );

  registry.add(
    automation,
    automationDescription,
    'list',
    apiAutomationListInputSchema.extend(operation('list')),
    'read',
    (actor, { op: _op, projectId, ...input }) =>
      cases.list(actor, projectId, input),
  );
  registry.add(
    automation,
    automationDescription,
    'get',
    apiAutomationGetInputSchema.extend(operation('get')),
    'read',
    (actor, { op: _op, projectId, ...input }) =>
      cases.get(actor, projectId, input),
  );
  registry.add(
    automation,
    automationDescription,
    'revisions',
    apiAutomationRevisionsInputSchema.extend(operation('revisions')),
    'read',
    (actor, { op: _op, projectId, ...input }) =>
      cases.revisions(actor, projectId, input),
  );
  registry.add(
    automation,
    automationDescription,
    'create-scenario',
    apiAutomationCreateScenarioInputSchema.extend(operation('create-scenario')),
    'write',
    (actor, { op: _op, projectId, ...input }) =>
      cases.createScenario(actor, projectId, input),
  );
  registry.add(
    automation,
    automationDescription,
    'create-case',
    apiAutomationCreateCaseInputSchema.extend(operation('create-case')),
    'write',
    (actor, { op: _op, projectId, ...input }) =>
      cases.createCase(actor, projectId, input),
  );
  registry.add(
    automation,
    automationDescription,
    'revise-scenario',
    apiAutomationReviseScenarioInputSchema.extend(operation('revise-scenario')),
    'write',
    (actor, { op: _op, projectId, ...input }) =>
      cases.reviseScenario(actor, projectId, input),
  );
  registry.add(
    automation,
    automationDescription,
    'revise-case',
    apiAutomationReviseCaseInputSchema.extend(operation('revise-case')),
    'write',
    (actor, { op: _op, projectId, ...input }) =>
      cases.reviseCase(actor, projectId, input),
  );
  registry.add(
    automation,
    automationDescription,
    'archive',
    apiAutomationArchiveInputSchema.extend(operation('archive')),
    'write',
    (actor, { op: _op, projectId, ...input }) =>
      cases.archive(actor, projectId, input),
  );
}
