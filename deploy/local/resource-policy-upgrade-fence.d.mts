export interface UpgradePermitIdentity {
  permitId: string;
  signature: string;
}
export class LocalPolicyUpgradeFenceError extends Error {
  readonly code: string;
  constructor(code: string);
}
/** No DB/key/reset. Directory must be private and outside backups. */
export class LocalPolicyUpgradeFence {
  readonly directory: string;
  readonly platformId: string;
  constructor(directory: string, platformId: string);
  bindPermit(identity: UpgradePermitIdentity): Promise<{ replayed: boolean }>;
  assertBound(identity: UpgradePermitIdentity): Promise<void>;
  /** Must use the real authenticated/validated anchor reader; this helper does not verify its signature. */
  beginInitialization(
    identity: UpgradePermitIdentity,
    readAnchor: () => Promise<unknown>,
  ): Promise<{ bootstrapAllowed: boolean }>;
}
