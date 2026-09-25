/**
 * The timeout budget, in one place.
 *
 * These numbers only make sense in relation to each other, and they are read by
 * two packages that must not import one another. Defining them apart is how
 * they drift until a tool call can outlive the slice that is running it.
 *
 * The chain, outermost first:
 *
 *   SLICE            how long one invocation may run (configuration)
 *    └─ RESERVE      kept back so the step in flight can finish and persist
 *        └─ TOOL     the longest a single tool call may block
 *
 * A tool timeout at or above the reserve is the failure this file exists to
 * prevent: the environment kills the invocation before our own timeout fires,
 * so instead of an error message the model can read, the run takes a lease
 * reclaim, a duplicate attempt, and possibly a repeated side effect.
 */

/**
 * Headroom kept back from a slice.
 *
 * Sized for the worst realistic step: a tool call running to its own ceiling,
 * then the writes that follow it.
 */
export const DEFAULT_RESERVE_MS = 45_000;

/** What a tool call gets unless a binding asks for less. */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/**
 * The hard ceiling on any per-binding tool timeout.
 *
 * Strictly below the reserve, with room left over for persisting the step.
 * A binding asking for more is clamped rather than refused: a slow server is a
 * reason to wait longer than default, never a reason to risk the slice.
 */
export const MAX_TOOL_TIMEOUT_MS = 30_000;

/**
 * Checks the chain holds.
 *
 * Called at the composition root, where the slice length is actually known.
 * A misconfiguration here does not fail visibly — it fails as an intermittent
 * reclaim under load, which is the hardest kind of bug to attribute.
 */
export function assertTimeoutBudget(sliceMs: number, reserveMs = DEFAULT_RESERVE_MS): void {
  if (reserveMs >= sliceMs) {
    throw new Error(
      `A reserve of ${reserveMs}ms leaves no room in a ${sliceMs}ms slice: the executor would ` +
        'yield before taking a single step, and the run would never progress.',
    );
  }
  if (MAX_TOOL_TIMEOUT_MS >= reserveMs) {
    throw new Error(
      `A tool may block for up to ${MAX_TOOL_TIMEOUT_MS}ms but only ${reserveMs}ms is reserved ` +
        'to finish and persist the step. The environment would kill the invocation before the ' +
        'tool timeout fired.',
    );
  }
}
