/**
 * Starts a single-node MongoDB replica set in Docker and waits for PRIMARY,
 * using the driver the repository already has rather than mongosh. Change
 * streams and transactions both need a replica set, so a plain mongod is not
 * enough for the app to boot.
 *
 * Several images are tried in turn: a MongoDB release can refuse to start on
 * the kernel a hosted runner happens to have (8.3 does on Linux 6.19), and
 * the pictures do not care which server version is underneath.
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
const NAME = 'shots-mongo';
const IMAGES = (process.env.MONGO_IMAGES ?? 'mongo:8.3,mongo:8.2,mongo:8.0,mongo:7.0,mongo:6.0').split(',');

const sh = (command, quiet = false) => execSync(command, { stdio: quiet ? 'ignore' : 'inherit' });
const running = () => {
  try { return execSync(`docker inspect -f '{{.State.Running}}' ${NAME}`).toString().trim() === 'true'; } catch { return false; }
};

async function ping() {
  const client = new MongoClient(`mongodb://127.0.0.1:${PORT}/?directConnection=true`, { serverSelectionTimeoutMS: 1500 });
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    return client;
  } catch {
    await client.close().catch(() => undefined);
    return undefined;
  }
}

let client;
for (const image of IMAGES) {
  try { sh(`docker rm -f ${NAME}`, true); } catch { /* nothing to remove */ }
  console.log(`starting ${image}`);
  sh(`docker run -d --name ${NAME} -p ${PORT}:${PORT} ${image} --replSet rs0 --bind_ip_all --port ${PORT}`);
  for (let i = 0; i < 30; i += 1) {
    client = await ping();
    if (client !== undefined) break;
    if (!running()) break;
    await sleep(1000);
  }
  if (client !== undefined) { console.log(`${image} answers`); break; }
  console.log(`${image} did not come up:`);
  try { sh(`docker logs --tail 5 ${NAME}`); } catch { /* the container may be gone */ }
}
if (client === undefined) { console.error('no MongoDB image started'); process.exit(1); }

const admin = client.db('admin');
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
