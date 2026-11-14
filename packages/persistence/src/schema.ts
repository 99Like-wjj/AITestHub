// SQL migrations are authoritative. Drizzle provides typed repository mappings only.
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

const app = pgSchema('app');
const createdAt = () =>
  timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`);
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`);

export const users = app.table('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  account: text('account').notNull().unique(),
  displayAccount: text('display_account').notNull().default(''),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
  active: boolean('active').notNull().default(true),
  removedAt: timestamp('removed_at', { withTimezone: true }),
  removedBy: uuid('removed_by'),
  credentialVersion: integer('credential_version').notNull().default(1),
  theme: text('theme').notNull().default('light'),
  rowVersion: integer('row_version').notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = app.table('sessions', {
  idHash: text('id_hash').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  credentialVersion: integer('credential_version').notNull().default(1),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const personalKeys = app.table('personal_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  keyHash: text('key_hash').notNull().unique(),
  prefix: text('prefix').notNull().default(''),
  name: text('name').notNull(),
  allowedScope: jsonb('allowed_scope')
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const projects = app.table('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  active: boolean('active').notNull().default(true),
  rowVersion: integer('row_version').notNull().default(1),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const projectMembers = app.table(
  'project_members',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    isAdmin: boolean('is_admin').notNull().default(false),
    active: boolean('active').notNull().default(true),
    roles: text('roles')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    rowVersion: integer('row_version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.userId] })],
);

export const passwordResets = app.table('password_resets', {
  hash: text('hash').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const commands = app.table(
  'commands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id),
    operation: text('operation').notNull().default(''),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    response: jsonb('response').$type<unknown>(),
    status: text('status').notNull().default('pending'),
    projectId: uuid('project_id').references(() => projects.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [unique().on(table.actorId, table.operation, table.key)],
);

export const outbox = app.table('outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  seq: bigint('seq', { mode: 'bigint' }).generatedAlwaysAsIdentity().unique(),
  eventType: text('event_type').notNull(),
  schemaVersion: integer('schema_version').notNull().default(1),
  projectId: uuid('project_id').references(() => projects.id),
  actorId: uuid('actor_id').references(() => users.id),
  aggregateId: uuid('aggregate_id'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  createdAt: createdAt(),
});

export const auditEvents = app.table('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  seq: bigint('seq', { mode: 'bigint' }).generatedAlwaysAsIdentity().unique(),
  actorId: uuid('actor_id').references(() => users.id),
  projectId: uuid('project_id').references(() => projects.id),
  action: text('action').notNull(),
  objectId: uuid('object_id'),
  requestId: text('request_id'),
  payload: jsonb('payload')
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  createdAt: createdAt(),
});
