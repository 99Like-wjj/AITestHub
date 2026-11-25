/** Restrict tool DTOs that include a person's display label to a public label. */
export function businessDisplayName(name: string, ...logins: string[]): string {
  const normalized = name.trim().toLowerCase();
  return logins.some((login) => login.trim().toLowerCase() === normalized)
    ? '项目成员'
    : name;
}

export function projectPersonData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectPersonData);
  if (!value || typeof value !== 'object' || value instanceof Date)
    return value;
  const fields = Object.fromEntries(Object.entries(value));
  const name = fields.displayName;
  const login = fields.account;
  if (typeof name === 'string' && typeof login === 'string') {
    fields.displayName = businessDisplayName(name, login);
    delete fields.account;
  }
  return Object.fromEntries(
    Object.entries(fields).map(([key, item]) => [key, projectPersonData(item)]),
  );
}
