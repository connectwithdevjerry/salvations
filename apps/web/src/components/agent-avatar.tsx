import { Icon } from '@/components/ui';
import { STATUS_COPY, type AgentStatus } from '@/components/agents-context';

/**
 * The coloured face every assistant is recognised by in the list and its
 * header. With a status, a small dot sits on its corner: green while it is
 * working, amber while it waits on the person, red after a failure, nothing
 * when it is idle. The words are in the tooltip, for anyone who wants them.
 */
export function AgentAvatar({
  color, size = 40, status,
}: {
  color: string;
  size?: number;
  status?: AgentStatus;
}) {
  return (
    <span
      className="agent-avatar"
      aria-hidden={status === undefined}
      {...(status !== undefined && status !== 'idle' ? { title: STATUS_COPY[status] } : {})}
      style={{ width: size, height: size, ['--agent' as string]: color }}
    >
      <Icon name="agent" size={Math.round(size * 0.52)} />
      {status !== undefined && status !== 'idle' && (
        <span className={`agent-dot ${status}`} role="img" aria-label={STATUS_COPY[status]} />
      )}
    </span>
  );
}
