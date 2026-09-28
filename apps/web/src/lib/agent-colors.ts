/**
 * Avatar tints, in the order new assistants take them, so neighbours in the
 * list differ. Its own module because both the agents route and the paths
 * that make assistants from roles need it, and neither should import the
 * other.
 */
export const AGENT_COLORS = [
  '#3b82f6', '#14b8a6', '#ef4444', '#f59e0b', '#8b5cf6', '#84cc16', '#06b6d4', '#ec4899',
] as const;
