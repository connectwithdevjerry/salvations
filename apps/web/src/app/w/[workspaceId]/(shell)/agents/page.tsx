'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ws } from '@/lib/client/api';
import { Tile } from '@/components/ui';

/**
 * Nothing chosen yet.
 *
 * With assistants, opens the main one rather than showing an empty pane —
 * there is nothing to decide. Without any, the one thing to do is make one,
 * so that is the whole page.
 */
export default function AgentsIndex({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  const router = useRouter();
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    api.get<{ items: { id: string; main: boolean }[] }>(`${ws(workspaceId)}/agents`)
      .then((r) => {
        const main = r.items.find((a) => a.main) ?? r.items[0];
        if (main === undefined) setEmpty(true);
        else router.replace(`/w/${workspaceId}/agents/${main.id}`);
      })
      .catch(() => setEmpty(true));
  }, [router, workspaceId]);

  if (!empty) return <div className="centered" />;

  return (
    <div className="centered">
      <div className="panel" style={{ textAlign: 'center' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
          <Tile name="agent" large />
        </div>
        <h3 style={{ margin: '0 0 6px', fontSize: 18 }}>Create your first assistant</h3>
        <p className="muted" style={{ margin: '0 0 18px' }}>
          Name it, connect the Telegram bot it answers on, and the model it thinks with. It starts
          with everything this workspace already knows.
        </p>
        <Link href={`/w/${workspaceId}/agents/new`}>
          <button className="primary lg" type="button">Create an assistant</button>
        </Link>
      </div>
    </div>
  );
}
