import { createDatabaseFromEnvironment } from '../packages/persistence/src/config.js';
import { migrateDatabase } from '../packages/persistence/src/migrate.js';

const database = await createDatabaseFromEnvironment();
try {
  const result = await migrateDatabase(database);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await database.close();
}
