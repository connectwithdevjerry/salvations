/**
 * Connecting a client to a server in the same process.
 *
 * `InMemoryTransport.createLinkedPair()` comes from the SDK rather than being
 * written here. A hand-rolled transport would have to reproduce the protocol's
 * framing and lifecycle exactly, and every divergence would show up as a
 * first-party server behaving subtly unlike a remote one — which is precisely
 * what this whole approach exists to avoid.
 */
import { InMemoryTransport, type Transport } from '@modelcontextprotocol/server';

export interface LinkedPair {
  /** Hand this to the client. */
  readonly clientTransport: Transport;
  /** Already connected to the server. */
  readonly serverTransport: Transport;
}

/**
 * A linked pair, with the server end already attached.
 *
 * Both ends are returned because the caller owns closing them: a pair left
 * open holds the server instance, and the server instance holds whatever its
 * tools closed over — for a per-run server, that is the run's own state.
 */
export function linkedPair(): [Transport, Transport] {
  const [a, b] = InMemoryTransport.createLinkedPair();
  return [a, b];
}
