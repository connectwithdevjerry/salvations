/**
 * The ONLY path from the runtime to MCP. There is no second route and no
 * exemption for platform-owned servers.
 */
import type { ToolDeclaration } from '../entities/model';
import type { ContentBlock } from '../entities/conversation';
import type { PermissionEffect } from '../entities/run';
import type { ApprovalId, McpBindingId } from '../ids';
import type { RunContext } from './run-context';

export type ToolOutcome =
  | {
      readonly kind: 'result';
      readonly content: readonly ContentBlock[];
      readonly structured?: unknown;
      readonly isError: boolean;
      readonly bindingId: McpBindingId;
      readonly durationMs: number;
      readonly mrtrRounds: number;
      /**
       * Why this call was permitted.
       *
       * Carried on the OUTCOME rather than looked up afterwards: the decision
       * was made against the arguments of this specific call, and re-deriving
       * it later against a policy that has since changed would show a reviewer
       * something that never happened.
       */
      readonly permission?: {
        readonly effect: PermissionEffect;
        readonly reason?: string;
        readonly matchedRuleId?: string;
      };
    }
  /** Policy requires a human. The run suspends; no process is held open. */
  | { readonly kind: 'needs_approval'; readonly approvalId: ApprovalId; readonly reason: string }
  /** An MCP server asked a question the runtime must route to a human. */
  | { readonly kind: 'needs_input'; readonly approvalId: ApprovalId; readonly requestState: string }
  /** A long-running MCP task; the run suspends and a poller resumes it. */
  | { readonly kind: 'task_pending'; readonly taskId: string; readonly bindingId: McpBindingId };

export interface ToolGateway {
  /** Declarations the principal may actually call — denied tools are never offered. */
  listAvailable(ctx: RunContext): Promise<readonly ToolDeclaration[]>;
  invoke(canonicalName: string, args: unknown, ctx: RunContext): Promise<ToolOutcome>;
}
