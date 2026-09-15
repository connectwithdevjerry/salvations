/**
 * Database role definitions.
 *
 * Two users, by design:
 *   app     — CRUD only. Cannot create or drop collections, cannot manage
 *             indexes, and cannot UPDATE OR DELETE the audit log.
 *   migrate — schema and index management. Never used to serve a request.
 *
 * The critical subtlety: MongoDB UNIONS privileges across matching resources.
 * Granting `update` on the whole database and then "restricting" auditLog to
 * find+insert does not restrict anything — the database-wide grant still
 * applies. The only way to withhold a privilege on one collection is to never
 * grant it database-wide, and to enumerate every collection individually.
 *
 * Generated from the collection registry so a new collection cannot be added
 * without also appearing here.
 */
import {
  GLOBAL_COLLECTIONS, MIXED_COLLECTIONS, TENANT_COLLECTIONS,
} from './collections';

const READ = ['find'] as const;
const WRITE = ['insert', 'update', 'remove'] as const;
const APPEND_ONLY = ['find', 'insert'] as const;

/** The audit log is evidence; the application must not be able to rewrite it. */
export const APPEND_ONLY_COLLECTIONS: readonly string[] = ['auditLog'];

interface Privilege {
  readonly resource: { readonly db: string; readonly collection: string };
  readonly actions: readonly string[];
}

export function appRolePrivileges(dbName: string): Privilege[] {
  const all = [...GLOBAL_COLLECTIONS, ...TENANT_COLLECTIONS, ...MIXED_COLLECTIONS];
  return all.map((collection) => ({
    resource: { db: dbName, collection },
    actions: APPEND_ONLY_COLLECTIONS.includes(collection)
      ? [...APPEND_ONLY]
      : [...READ, ...WRITE],
  }));
}

export function migrateRolePrivileges(dbName: string): Privilege[] {
  return [
    {
      // Collection "" means database-wide, which is appropriate here: the
      // migration user's whole job is schema and index management.
      resource: { db: dbName, collection: '' },
      actions: [
        'find', 'insert', 'update', 'remove',
        'createCollection', 'createIndex', 'dropIndex', 'listIndexes',
        'collMod', 'listCollections',
      ],
    },
  ];
}

/**
 * Emits the mongosh commands to create both roles.
 *
 * Printed rather than executed: creating database users is an administrative
 * act that should be reviewed and run deliberately, not as a side effect of a
 * deploy.
 */
export function roleScript(dbName: string): string {
  const app = JSON.stringify(appRolePrivileges(dbName), null, 2);
  const migrate = JSON.stringify(migrateRolePrivileges(dbName), null, 2);

  return `// Run against the "admin" database of your cluster.
// Review before running: this grants database access.

use admin;

db.createRole({
  role: "salvationsApp",
  // Enumerated per collection ON PURPOSE. MongoDB unions privileges, so a
  // database-wide write grant would silently re-grant update/remove on
  // auditLog and defeat its append-only guarantee.
  privileges: ${app},
  roles: []
});

db.createRole({
  role: "salvationsMigrate",
  privileges: ${migrate},
  roles: []
});

// Create the users (replace the passwords).
db.createUser({ user: "salvations_app",     pwd: "<APP_PASSWORD>",     roles: [{ role: "salvationsApp",     db: "admin" }] });
db.createUser({ user: "salvations_migrate", pwd: "<MIGRATE_PASSWORD>", roles: [{ role: "salvationsMigrate", db: "admin" }] });

// Verify the append-only guarantee actually holds:
//   mongosh --username salvations_app ...
//   use ${dbName};
//   db.auditLog.updateOne({}, { $set: { action: "tampered" } });   // must fail
//   db.auditLog.deleteOne({});                                      // must fail
`;
}

if (process.argv[1]?.endsWith('atlas-roles.ts') === true) {
  process.stdout.write(roleScript(process.env['MONGODB_DB_NAME'] ?? 'salvations'));
}
