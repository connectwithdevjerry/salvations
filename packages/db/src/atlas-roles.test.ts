import { describe, expect, it } from 'vitest';
import { appRolePrivileges, migrateRolePrivileges, roleScript } from './atlas-roles';
import { GLOBAL_COLLECTIONS, MIXED_COLLECTIONS, TENANT_COLLECTIONS } from './collections';

const DB = 'salvations';
const privilegeFor = (collection: string) =>
  appRolePrivileges(DB).find((p) => p.resource.collection === collection);

describe('application role', () => {
  it('covers every declared collection', () => {
    // A collection absent here is a collection the app cannot read — which
    // surfaces as an authorization error at runtime, far from the cause.
    const declared = [...GLOBAL_COLLECTIONS, ...TENANT_COLLECTIONS, ...MIXED_COLLECTIONS];
    const granted = new Set(appRolePrivileges(DB).map((p) => p.resource.collection));
    for (const collection of declared) {
      expect(granted.has(collection)).toBe(true);
    }
  });

  it('never grants a database-wide privilege', () => {
    // MongoDB unions privileges. One database-wide write grant would silently
    // re-grant update and remove on auditLog and defeat the whole arrangement.
    for (const privilege of appRolePrivileges(DB)) {
      expect(privilege.resource.collection).not.toBe('');
    }
  });

  it('gives the audit log find and insert only', () => {
    const audit = privilegeFor('auditLog');
    expect(audit?.actions).toEqual(['find', 'insert']);
    expect(audit?.actions).not.toContain('update');
    expect(audit?.actions).not.toContain('remove');
  });

  it('gives ordinary collections full CRUD', () => {
    expect(privilegeFor('runs')?.actions).toEqual(
      expect.arrayContaining(['find', 'insert', 'update', 'remove']),
    );
  });

  it('cannot create or drop collections, or manage indexes', () => {
    // Schema change is the migration user's job; the app must not be able to
    // drop a collection under load.
    for (const privilege of appRolePrivileges(DB)) {
      for (const forbidden of ['createCollection', 'dropCollection', 'createIndex', 'dropIndex', 'dropDatabase']) {
        expect(privilege.actions).not.toContain(forbidden);
      }
    }
  });
});

describe('migration role', () => {
  it('can manage schema and indexes', () => {
    const actions = migrateRolePrivileges(DB)[0]?.actions ?? [];
    expect(actions).toEqual(
      expect.arrayContaining(['createCollection', 'createIndex', 'collMod']),
    );
  });

  it('is never granted dropDatabase', () => {
    expect(migrateRolePrivileges(DB)[0]?.actions).not.toContain('dropDatabase');
  });
});

describe('role script', () => {
  it('emits both roles and a verification step', () => {
    const script = roleScript(DB);
    expect(script).toContain('salvationsApp');
    expect(script).toContain('salvationsMigrate');
    // The script tells the operator how to confirm the guarantee holds rather
    // than asking them to take it on trust.
    expect(script).toContain('must fail');
  });

  it('contains no real password', () => {
    expect(roleScript(DB)).toContain('<APP_PASSWORD>');
  });
});
