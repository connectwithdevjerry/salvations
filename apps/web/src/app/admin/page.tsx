'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { auth, type SignedInUser } from '@/lib/client/auth';
import { DeploymentSettings } from '@/components/deployment-settings';
import { Loader } from '@/components/loader';
import { Icon } from '@/components/ui';

/**
 * The deployment's own page: the keys it holds, for whoever runs it.
 *
 * Separate from any workspace, because these settings belong to none. The
 * same section is shown at the bottom of a workspace's admin dashboard for
 * convenience; this is the address to hand to the operator.
 */
export default function DeploymentAdminPage() {
  const router = useRouter();
  const [user, setUser] = useState<SignedInUser | null>();

  useEffect(() => {
    auth.session()
      .then((r) => {
        if (r.user === null) { router.replace('/signin?returnTo=/admin'); return; }
        setUser(r.user);
      })
      .catch(() => router.replace('/signin?returnTo=/admin'));
  }, [router]);

  if (user === undefined) return <div className="centered"><Loader label="Checking who you are" /></div>;

  return (
    <div className="page" style={{ maxWidth: 920, margin: '0 auto', padding: '28px 16px 48px' }}>
      <header style={{ marginBottom: 18 }}>
        <p className="eyebrow" style={{ marginTop: 0 }}>Deployment</p>
        <h2 style={{ margin: '2px 0 6px' }}>Keys this deployment holds</h2>
        <p className="lede" style={{ margin: 0 }}>
          The OpenAI key behind Yashayah, the included model, and the apps behind one-press Slack, Discord and WhatsApp.
          Set them here and they are in force within a minute, with no redeploy.
        </p>
        <p style={{ margin: '10px 0 0' }}>
          <Link href="/go">← Back to your workspace</Link>
        </p>
      </header>

      {user?.platformAdmin === true ? (
        <DeploymentSettings />
      ) : (
        <div className="note">
          <span className="tile" aria-hidden><Icon name="shield" size={16} /></span>
          <span>
            <strong>This page is for whoever runs the deployment.</strong> You are signed in as {user?.email},
            which is not on its admin list. The list is the PLATFORM_ADMIN_EMAILS setting on the deployment itself.
          </span>
        </div>
      )}
    </div>
  );
}
