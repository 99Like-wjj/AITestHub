import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { registerInputSchema } from '../packages/contracts/src/identity.js';
import { createDatabaseFromEnvironment } from '../packages/persistence/src/config.js';
import { hashPassword } from '../packages/application/src/identity/password.js';

// Local operator entry only. The password file path is not a password and its contents are never logged.
const account = process.env.AITESTHUB_BOOTSTRAP_ACCOUNT;
const displayName = process.env.AITESTHUB_BOOTSTRAP_NAME;
const passwordFile = process.env.AITESTHUB_BOOTSTRAP_PASSWORD_FILE;
if (!passwordFile)
  throw new Error('AITESTHUB_BOOTSTRAP_PASSWORD_FILE is required.');
const password = await readFile(passwordFile, 'utf8');
const input = registerInputSchema.parse({ account, displayName, password });
const passwordHash = await hashPassword(input.password);
const db = await createDatabaseFromEnvironment();
try {
  await db.transaction(async (tx) => {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtext('aitesthub-bootstrap-admin'))",
    );
    if (
      (
        await tx.query(
          "SELECT 1 FROM app.installation_state WHERE key='administrator-initialized'",
        )
      ).rowCount
    ) {
      throw new Error(
        'An administrator already exists; bootstrap cannot be repeated.',
      );
    }
    const userId = randomUUID();
    await tx.query(
      `INSERT INTO app.users(id,account,display_account,display_name,password_hash,is_platform_admin)
       VALUES($1,$2,$3,$4,$5,true)`,
      [
        userId,
        input.account.toLowerCase(),
        input.account,
        input.displayName,
        passwordHash,
      ],
    );
    await tx.query(
      "INSERT INTO app.installation_state(key,initialized_by) VALUES('administrator-initialized',$1)",
      [userId],
    );
  });
  process.stdout.write(
    'Local administrator initialized. No credential was printed.\n',
  );
} finally {
  await db.close();
}
