'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/client/api';
import { BrandMark } from '@/components/ui';
import { Loader } from '@/components/loader';

/**
 * Accepting an invitation.
 *
 * Somebody not signed in is sent to sign in and brought straight back; the
 * link is theirs to keep until it expires. Signed in as the wrong address,
 * the page says which address the invitation is for rather than failing
 * quietly, because that is the mistake people actually make.
 */
interface Preview {
  workspace: { id: string; name: string };
  role: string;
  email: string;
  matches: boolean;
  already: boolean;
}

export default function JoinPage({ params }: { params: Promise<{ workspaceId: string; token: string }> }) {
  const { workspaceId, token } = use(params);
  const router = useRouter();
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const path = `/api/invitations/${workspaceId}/${token}`;

  useEffect(() => {
    api.get<Preview>(path)
      .then(setPreview)
      .catch((caught: unknown) => {
        if (caught instanceof ApiError && caught.status === 401) {
          router.replace(`/signin?returnTo=${encodeURIComponent(`/join/${workspaceId}/${token}`)}`);
          return;
        }
        setError(caught instanceof Error ? caught.message : 'This invitation could not be read.');
      });
  }, [path, router, workspaceId, token]);

  return (
    <div className="centered">
      <div className="panel">
        <div style={{ marginBottom: 18 }}><BrandMark /></div>
        {error !== undefined && <p className="error">{error}</p>}
        {preview === undefined && error === undefined && <Loader label="Reading your invitation" />}
        {preview !== undefined && (
          <>
            <h2 style={{ margin: '0 0 6px', fontSize: 20 }}>
              {preview.already ? `You are already in ${preview.workspace.name}` : `Join ${preview.workspace.name}`}
            </h2>
            <p className="muted" style={{ margin: '0 0 18px' }}>
              {preview.already
                ? 'Nothing to accept.'
                : `You have been invited as ${preview.role === 'admin' ? 'an' : 'a'} ${preview.role}.`}
            </p>
            {!preview.already && !preview.matches && (
              <p className="error">
                This invitation is for {preview.email}. Sign out and sign in with that address to accept it.
              </p>
            )}
            <button
              type="button" className="primary lg"
              disabled={busy || (!preview.already && !preview.matches)}
              onClick={async () => {
                setBusy(true);
                try {
                  const joined = await api.post<{ joined: string }>(path);
                  router.replace(`/w/${joined.joined}/agents`);
                } catch (caught) {
                  setError(caught instanceof Error ? caught.message : 'Could not join.');
                  setBusy(false);
                }
              }}
            >
              {preview.already ? 'Open the workspace' : busy ? 'Joining…' : 'Accept and join'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
