/**
 * Index synchronisation.
 *
 * Runs under the `migrate` database user, never the application user — the app
 * has no business changing schema. Idempotent, so it is safe on every deploy.
 */
import { MongoClient } from 'mongodb';
import { syncIndexes, indexCount } from './indexes';
import { syncValidators, unvalidatedCollections } from './validators';

export async function runMigrations(uri: string, dbName: string): Promise<void> {
  // Command monitoring is off here: migrations are platform-wide by definition
  // and would trip the tenancy guard on every index creation.
  const client = new MongoClient(uri, { appName: 'salvations-migrate' });
  try {
    await client.connect();
    const db = client.db(dbName);

    // Validators first: a collection created by an index sync would otherwise
    // exist without one, and collMod cannot retroactively validate what is
    // already inside it.
    const validators = await syncValidators(db);
    process.stdout.write(`validators: ${validators.applied.length} applied\n`);
    for (const problem of validators.skipped) process.stderr.write(`  ! ${problem}\n`);

    const pending = unvalidatedCollections();
    if (pending.length > 0) {
      process.stdout.write(`  (no validator yet: ${pending.join(', ')})\n`);
    }

    const result = await syncIndexes(db);
    process.stdout.write(
      `indexes: ${result.created.length} created, ${result.existing.length} already present ` +
        `(${indexCount()} declared)\n`,
    );
    for (const name of result.created) process.stdout.write(`  + ${name}\n`);
  } finally {
    await client.close();
  }
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');

if (isEntrypoint) {
  const uri = process.env['MONGODB_URI'];
  if (uri === undefined || uri === '') {
    process.stderr.write('MONGODB_URI is required\n');
    process.exit(1);
  }
  await runMigrations(uri, process.env['MONGODB_DB_NAME'] ?? 'salvations');
}
