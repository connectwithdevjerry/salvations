/**
 * Starts a single-node MongoDB replica set in Docker and waits for PRIMARY,
 * using the driver the repository already has rather than mongosh. Change
 * streams and transactions both need a replica set, so a plain mongod is not
 * enough for the app to boot.
 */
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';

const require = createRequire(new URL('../../packages/db/package.json', import.meta.url));
const { MongoClient } = require('mongodb');

const PORT = 27017;
execSync(`docker run -d --name shots-mongo -p ${PORT}:${PORT} mongo:8.3 --replSet rs0 --bind_ip_all --port ${PORT}`, { stdio: 'inherit' });

const client = new MongoClient(`mongodb://127.0.0.1:${PORT}/?directConnection=true`, { serverSelectionTimeoutMS: 2000 });
let admin;
for (let i = 0; i < 60; i += 1) {
  try {
    await client.connect();
    admin = client.db('admin');
    await admin.command({ ping: 1 });
    break;
  } catch {
    await sleep(1000);
  }
}
if (admin === undefined) { console.error('mongod never answered'); process.exit(1); }

try {
  await admin.command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: `127.0.0.1:${PORT}` }] } });
} catch (caught) {
  if (!/already initialized/i.test(String(caught))) throw caught;
}
for (let i = 0; i < 60; i += 1) {
  const hello = await admin.command({ hello: 1 });
  if (hello.isWritablePrimary === true) { console.log('replica set rs0 is PRIMARY'); await client.close(); process.exit(0); }
  await sleep(1000);
}
console.error('timed out waiting for PRIMARY');
process.exit(1);
