export const deploymentProfileFixture = {
  schemaVersion: 'aitesthub.deployment-profile.v1',
  platformId: '11111111-1111-4111-8111-111111111111',
  origin: 'https://aitesthub.example.invalid',
  host: 'aitesthub.example.invalid',
  hostKeyFingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  root: '/srv/aitesthub-private',
  releaseRoot: '/srv/aitesthub/releases',
  account: 'deployment-admin',
  sshUser: 'deploy',
  sshGroup: 'deploy',
  oldImage:
    'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  legacyModels: [],
  containers: {
    api: 'aitesthub-api-1',
    apiWorker: 'aitesthub-api-worker-1',
    aiWorker: 'aitesthub-ai-worker-1',
    database: 'aitesthub-postgres',
  },
  opsUnit: 'aitesthub-ops.service',
  policyMigration: {
    version: '0034_resource_policy.sql',
    checksum:
      'ac84e64462bea989f009667aeca8b61fc1c973b7ab40f9775e4e279f51d29ea0',
  },
  previousMigration: {
    version: '0033_ui_delivery.sql',
    checksum:
      '436ea1cc48958f2d8d537d8b58bc9b86f0a53d33b2c754f53bdd9a8a451b2744',
  },
};
