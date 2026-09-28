'use client';

import { use } from 'react';
import Link from 'next/link';
import { Icon, Tile } from '@/components/ui';
import { EmptyState } from '@/components/empty-state';
import { useAgents } from '@/components/agents-context';
import { SkeletonPage } from '@/components/skeleton';

/**
 * Nothing chosen yet.
 *
 * Says so, rather than quietly opening one: the list is on the left, and a
 * page that jumps to an assistant the moment it loads takes the choice away
 * and looks like a bug when it lands somewhere unexpected. With none made,
 * the one thing to do is make one, so that is the whole page.
 */
export default function AgentsIndex({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  const { agents } = useAgents();
  const count = agents?.length;

  if (count === undefined) {
    return <div className="page"><SkeletonPage blocks={2} /></div>;
  }

  if (count === 0) {
    return (
      <div className="centered">
        <div className="panel" style={{ textAlign: 'center' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
            <Tile name="agent" large />
          </div>
          <h3 style={{ margin: '0 0 6px', fontSize: 18 }}>Build your team</h3>
          <p className="muted" style={{ margin: '0 0 18px' }}>
            A manager, marketing, sales, support and a personal assistant, each with its job written in,
            or one assistant with the role you choose. They all start with everything this workspace knows.
          </p>
          <div className="row" style={{ justifyContent: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Link href={`/w/${workspaceId}/agents/team`}>
              <button className="primary lg" type="button" data-tour="create-assistant">Start with a team</button>
            </Link>
            <Link href={`/w/${workspaceId}/agents/new`}>
              <button className="lg" type="button">Create one assistant</button>
            </Link>
          </div>
          <p className="muted" style={{ margin: '14px 0 0', fontSize: 13 }}>
            Already have an assistant somewhere else? <Link href={`/w/${workspaceId}/agents/import`}>Bring it here</Link>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="centered">
      <EmptyState
        art="select"
        title="Select an assistant"
        body={`You have ${count} ${count === 1 ? 'assistant' : 'assistants'}. Choose one on the left to chat, speak, or see what it knows — or make another.`}
        action={(
          <Link href={`/w/${workspaceId}/agents/new`}>
            <button type="button"><Icon name="plus" size={15} /> New assistant</button>
          </Link>
        )}
      />
    </div>
  );
}
