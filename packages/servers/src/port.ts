/**
 * First-party MCP servers.
 *
 * These run in this process and are reached over an in-memory transport, but
 * they are MCP servers in every other respect: the same client connects to
 * them, the same gateway sits in front of them, and the same approval and
 * audit path applies. That is the point of doing it this way rather than
 * calling a repository directly from the runtime — a tool is a tool, wherever
 * it happens to be implemented, and the moment our own tools take a shortcut
 * past the gateway they stop being subject to the policy everything else is.
 *
 * A server is built PER RUN, with the conversation it belongs to baked in. So
 * "a server per chat" is literally true, without a process per chat: the
 * instance is cheap, lives for one slice, and its tools can only ever see the
 * conversation it was constructed with.
 */
import type { WorkspaceId } from '@salvations/core';

/**
 * Everything a first-party server is allowed to know about its caller.
 *
 * Deliberately small, and deliberately not a database handle. A server that
 * received one could reach anything; one that receives this can only do what
 * its factory chose to give it.
 */
export interface ServerContext {
  readonly workspaceId: WorkspaceId | string;
  /** The conversation this server instance belongs to. Never changes. */
  readonly conversationId: string;
  readonly agentId: string;
  readonly runId: string;
}

/** A named server this deployment can build. */
export interface FirstPartyServer {
  /** Stable, and what a binding stores. Renaming one is a migration. */
  readonly name: string;
  readonly title: string;
  readonly description: string;
}
