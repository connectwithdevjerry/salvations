import { Icon } from '@/components/ui';

/** The coloured face every assistant is recognised by in the list and its header. */
export function AgentAvatar({ color, size = 40 }: { color: string; size?: number }) {
  return (
    <span
      className="agent-avatar"
      aria-hidden
      style={{ width: size, height: size, ['--agent' as string]: color }}
    >
      <Icon name="agent" size={Math.round(size * 0.52)} />
    </span>
  );
}
