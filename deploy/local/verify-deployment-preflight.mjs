// Read-only deployment guard; does not claim, cancel, retry or replay work.
import { createDatabaseFromEnvironment } from '../../dist/packages/persistence/src/config.js';
const db = await createDatabaseFromEnvironment();
try {
  const live = (
    await db.query(`SELECT
    (SELECT count(*)::int FROM app.api_worker_grants g JOIN app.runs r ON r.id=g.run_id WHERE g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND r.state IN ('prepared','running','stopping')) live_api_grants,
    (SELECT count(*)::int FROM app.ai_tasks WHERE state IN ('running','cancelling')) active_ai_tasks,
    (SELECT count(*)::int FROM app.ai_tasks WHERE state='accepted') accepted_ai_tasks,
    (SELECT count(*)::int FROM app.auxiliary_tasks WHERE state IN ('accepted','running','cancelling')) active_auxiliary_tasks,
    (SELECT phase FROM app.maintenance_state WHERE singleton) maintenance_phase`)
  ).rows[0];
  const safeToReplace =
    live.live_api_grants === 0 &&
    live.active_ai_tasks === 0 &&
    live.active_auxiliary_tasks === 0 &&
    live.maintenance_phase === 'idle';
  console.log({
    safeToReplace,
    ...live,
    lastMigration: (
      await db.query(
        'SELECT version,checksum FROM app.schema_migrations ORDER BY version DESC LIMIT 1',
      )
    ).rows[0],
  });
  if (!safeToReplace) process.exitCode = 1;
} finally {
  await db.close();
}
