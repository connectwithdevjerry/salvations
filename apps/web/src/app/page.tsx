'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/client/api';

interface Workspace { id: string; name: string; slug: string; role: string }

/**
 * The front door.
 *
 * Sends a signed-out visitor to sign in, a signed-in one with a workspace
 * straight into it, and a signed-in one with none to the form that makes their
 * first. Nobody should have to understand the difference.
 */
export default function Home() {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<Workspace[]>();
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ items: Workspace[] }>('/api/workspaces')
      .then((result) => {
        if (result.items.length > 0) {
          router.replace(`/w/${result.items[0]?.id}/chat`);
          return;
        }
        setWorkspaces(result.items);
      })
      .catch((caught: unknown) => {
        if (caught instanceof ApiError && caught.status === 401) {
          router.replace('/signin');
          return;
        }
        setError(caught instanceof Error ? caught.message : 'Something went wrong.');
      });
  }, [router]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const created = await api.post<Workspace>('/api/workspaces', { name });
      router.push(`/w/${created.id}/chat`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the workspace.');
      setBusy(false);
    }
  }

  if (workspaces === undefined) {
    return <div className="centered"><p className="muted">{error ?? 'Loading…'}</p></div>;
  }

  return (
    <div className="centered">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Create a workspace</h2>
        <p className="muted">
          Agents, servers, credentials and policies all live inside a workspace.
        </p>
        <form className="stack" onSubmit={create}>
          <div>
            <label htmlFor="name">Name</label>
            <input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          {error !== undefined && <p className="error">{error}</p>}
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create workspace'}
          </button>
        </form>
      </div>
    </div>
  );
}
