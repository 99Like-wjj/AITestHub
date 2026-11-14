import { createDatabaseFromEnvironment } from '../../../packages/persistence/src/config.js';
import { createApp } from './app.js';
import { NotificationService } from '../../../packages/application/src/notifications/service.js';
import { ScheduleService } from '../../../packages/application/src/schedules/service.js';

const db = await createDatabaseFromEnvironment();
const app = await createApp(db);
const schedules = app.get(ScheduleService);
await schedules.runtime.start(1000);
const port = Number(process.env.AITESTHUB_PORT ?? '5300');
if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
  throw new Error('AITESTHUB_PORT is invalid.');
await app.listen(port, process.env.AITESTHUB_HOST ?? '127.0.0.1');
const notifications = app.get(NotificationService);
notifications.start();
process.stdout.write(`AITestHub API listening on port ${port}.\n`);
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await schedules.runtime.stop();
  await notifications.stop();
  await app.close();
  await db.close();
}
process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});
