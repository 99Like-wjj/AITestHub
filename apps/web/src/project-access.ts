import type { Project } from './types';

export function canEditProjectRequirements(
  project: Project | null | undefined,
) {
  return Boolean(
    project?.inheritsPlatformAdmin || project?.roles.includes('tester'),
  );
}

export function canEditProjectAssets(project: Project | null | undefined) {
  return Boolean(
    project?.inheritsPlatformAdmin || project?.roles.includes('tester'),
  );
}
