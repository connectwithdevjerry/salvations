#!/usr/bin/env bash
# Initialises the local single-node replica set and waits for PRIMARY.
# Change streams and transactions both require a replica set.
set -euo pipefail
C=salvations-mongo
echo "waiting for mongod…"
for i in $(seq 1 40); do
  docker exec "$C" mongosh --quiet --eval "db.adminCommand('ping').ok" >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$C" mongosh --quiet --eval '
  try { rs.status().ok } catch (e) { rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]}) }
' >/dev/null 2>&1 || true
echo "waiting for PRIMARY…"
for i in $(seq 1 40); do
  ok=$(docker exec "$C" mongosh --quiet --eval 'db.hello().isWritablePrimary' 2>/dev/null | tr -d '[:space:]')
  [ "$ok" = "true" ] && { echo "replica set rs0 is PRIMARY"; exit 0; }
  sleep 1
done
echo "timed out waiting for PRIMARY" >&2; exit 1
