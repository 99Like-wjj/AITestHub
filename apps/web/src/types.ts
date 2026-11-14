import type { z } from 'zod';
import type { personalKeySchema } from '../../../packages/contracts/src/identity';
export type {
  User,
  AdminUser,
  UserSummary,
  Project,
  ProjectMember,
  Me,
} from '../../../packages/contracts/src/identity';
export type {
  Theme as ThemeMode,
  ProjectRole as Role,
} from '../../../packages/contracts/src/identity';
import type { ProjectRole as Role } from '../../../packages/contracts/src/identity';
export type PersonalKey = z.infer<typeof personalKeySchema>;

export const roleOptions: { label: string; value: Role }[] = [
  { label: '测试人员', value: 'tester' },
  { label: '开发人员', value: 'developer' },
  { label: '产品人员', value: 'product' },
];

export const roleLabels: Record<Role, string> = {
  tester: '测试',
  developer: '开发',
  product: '产品',
};
