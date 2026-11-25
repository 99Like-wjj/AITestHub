import { z } from 'zod';
import {
idSchema,
persistedRowVersionSchema,
rowVersionSchema,
timestampSchema,
titleSchema,
} from './base.js';

export const accountSchema = z.string().regex(/^[A-Za-z0-9._-]{3,64}$/);
export const passwordSchema = z
  .string()
  .min(8, '密码须为 8–128 个字符，并包含字母和特殊符号')
  .max(128, '密码须为 8–128 个字符，并包含字母和特殊符号')
  .regex(/[A-Za-z]/, '密码须包含字母')
  .regex(/[\p{P}\p{S}]/u, '密码须包含特殊符号');
export const displayNameSchema = z.string().trim().min(1).max(50);
export const themeSchema = z.enum(['light', 'dark', 'system']);
export const projectRoleSchema = z.enum(['tester', 'developer', 'product']);
export const projectRolesSchema = z
  .array(projectRoleSchema)
  .max(3)
  .refine((roles) => new Set(roles).size === roles.length, {
    message: '业务角色不可重复',
  });
export const registerInputSchema = z.strictObject({
  account: accountSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
});
export const loginInputSchema = z.strictObject({
  account: accountSchema,
  password: z.string().min(1).max(128),
});
export const changePasswordInputSchema = z.strictObject({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});
export const profileUpdateInputSchema = z.strictObject({
  displayName: displayNameSchema,
  theme: themeSchema,
  rowVersion: persistedRowVersionSchema,
});
export const resetPasswordInputSchema = z.strictObject({
  resetCode: z.string().min(16).max(512),
  newPassword: passwordSchema,
});
export const assistPasswordResetInputSchema = z.strictObject({
  userId: idSchema,
  rowVersion: persistedRowVersionSchema,
});
export const userSchema = z.strictObject({
  id: idSchema,
  account: accountSchema,
  displayName: displayNameSchema,
  isPlatformAdmin: z.boolean(),
  theme: themeSchema,
  rowVersion: persistedRowVersionSchema,
});
export const userSummarySchema = z.strictObject({
  id: idSchema,
  account: accountSchema,
  displayName: displayNameSchema,
  active: z.boolean(),
});
export const memberCandidatesSchema = z.strictObject({
  users: z.array(
    userSummarySchema.safeExtend({
      membership: z
        .strictObject({
          active: z.boolean(),
          rowVersion: persistedRowVersionSchema,
        })
        .nullable(),
    }),
  ),
});
export const adminUserSchema = userSummarySchema.extend({
  isPlatformAdmin: z.boolean(),
  rowVersion: persistedRowVersionSchema,
  removedAt: timestampSchema.nullable().default(null),
  removedBy: idSchema.nullable().default(null),
});
export const projectSchema = z.strictObject({
  id: idSchema,
  name: titleSchema,
  isAdmin: z.boolean(),
  roles: projectRolesSchema,
  rowVersion: persistedRowVersionSchema,
});
export const webProjectSchema = projectSchema.extend({
  inheritsPlatformAdmin: z.boolean(),
});
export const meSchema = z.strictObject({
  user: userSchema,
  projects: z.array(webProjectSchema),
});
export const createProjectInputSchema = z.strictObject({
  name: titleSchema,
  administratorIds: z
    .array(idSchema)
    .min(1)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: '项目管理员不可重复',
    }),
});
export const updateProjectInputSchema = z.strictObject({
  name: titleSchema,
  rowVersion: persistedRowVersionSchema,
});
export const projectMemberSchema = z.strictObject({
  userId: idSchema,
  account: accountSchema,
  displayName: displayNameSchema,
  active: z.boolean(),
  isAdmin: z.boolean(),
  roles: projectRolesSchema,
  rowVersion: persistedRowVersionSchema,
});
// rowVersion=0 is an explicit insert baseline; existing members require their current version.
export const updateMemberInputSchema = z.strictObject({
  isAdmin: z.boolean(),
  roles: projectRolesSchema,
  rowVersion: rowVersionSchema,
});
export const removeMemberInputSchema = z.strictObject({
  rowVersion: persistedRowVersionSchema,
});
export const adminUpdateUserInputSchema = z.strictObject({
  active: z.boolean(),
  isPlatformAdmin: z.boolean(),
  rowVersion: persistedRowVersionSchema,
});
export const removeAccountInputSchema = z.strictObject({
  commandId: idSchema,
  rowVersion: persistedRowVersionSchema,
});
export const accountRemovalReceiptSchema = z
  .strictObject({
    commandId: idSchema,
    user: adminUserSchema,
    removedAt: timestampSchema,
    removedBy: idSchema,
    businessDataDeleted: z.literal(false),
  })
  .refine(
    (receipt) =>
      !receipt.user.active &&
      receipt.user.removedBy === receipt.removedBy &&
      receipt.user.removedAt !== null &&
      Date.parse(receipt.user.removedAt) === Date.parse(receipt.removedAt),
    { message: '移除回执中的账号状态、操作者和时间必须一致。', path: ['user'] },
  );
export const actorEntrypointSchema = z.enum([
  'web',
  'internal-ai',
  'official-mcp',
  'worker',
]);
export const capabilitySchema = z.enum([
  'platform.manage',
  'project.read',
  'project.members.manage',
  'requirements.write',
  'requirements.participants.write',
  'requirements.state.write',
  'assets.write',
  'reviews.approve',
  'plans.write',
  'runs.organize',
  'files.transfer',
  'results.submit',
  'results.assess',
  'test-configuration.read',
  'test-configuration.write',
  'database-connections.metadata.read',
  'database-connections.write',
  'issues.create',
  'issues.handle',
  'issues.lifecycle',
  'knowledge.write',
  'personal-key.manage',
  'personal.data',
]);
export const capabilitiesSchema = z.array(capabilitySchema);
export const actorContextSchema = z.strictObject({
  userId: idSchema,
  entrypoint: actorEntrypointSchema,
  requestId: z.string().min(1).max(128),
  keyId: idSchema.optional(),
  allowedCapabilities: capabilitiesSchema.optional(),
});
export const personalKeySchema = z.strictObject({
  id: idSchema,
  name: z.string().trim().min(1).max(100),
  prefix: z.string().min(1).max(32),
  createdAt: timestampSchema,
  revokedAt: timestampSchema.nullable(),
});
export const createPersonalKeyInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  allowedCapabilities: capabilitiesSchema.optional(),
});
// Web-only first-display response. This type must never enter AI/MCP tool output.
export const personalKeyCreatedSchema = z.strictObject({
  key: personalKeySchema,
  rawKey: z.string().min(32).max(512),
});
export const usersListSchema = z.strictObject({
  users: z.array(adminUserSchema),
});
export const adminUserPageQuerySchema = z.strictObject({
  search: z.string().trim().max(100).default(''),
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  includeRemoved: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .default(false),
});
export const adminUserPageSchema = usersListSchema.safeExtend({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(100),
  total: z.number().int().nonnegative(),
});
export const membersListSchema = z.strictObject({
  members: z.array(projectMemberSchema),
});
export const keysListSchema = z.strictObject({
  keys: z.array(personalKeySchema),
});

export type RegisterInput = z.infer<typeof registerInputSchema>;
export type LoginInput = z.infer<typeof loginInputSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordInputSchema>;
export type ProfileUpdateInput = z.infer<typeof profileUpdateInputSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordInputSchema>;
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
export type UpdateMemberInput = z.infer<typeof updateMemberInputSchema>;
export type User = z.infer<typeof userSchema>;
export type AdminUser = z.infer<typeof adminUserSchema>;
export type AccountRemovalReceipt = z.infer<typeof accountRemovalReceiptSchema>;
export type UserSummary = z.infer<typeof userSummarySchema>;
export type Me = z.infer<typeof meSchema>;
export type Project = z.infer<typeof projectSchema>;
export type WebProject = z.infer<typeof webProjectSchema>;
export type ProjectMember = z.infer<typeof projectMemberSchema>;
export type Theme = z.infer<typeof themeSchema>;
export type ProjectRole = z.infer<typeof projectRoleSchema>;
export type Capability = z.infer<typeof capabilitySchema>;
export type ActorContext = z.infer<typeof actorContextSchema>;
