'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/client/api';
import { AgentAvatar } from '@/components/agent-avatar';
import { BrandMark } from '@/components/ui';
import { Loader } from '@/components/loader';

/**
 * The consent screen.
 *
 * A client — Claude.ai, ChatGPT, a desktop app — has sent the person here to
 * ask for one assistant. The page says who is asking and what they will get,
 * and takes one answer. Somebody not signed in goes to sign in and comes
 * straight back with the same request.
 */

interface Described {
  client: { id: string; name: string; uri?: string; logo?: string };
  workspace: { id: string; name: string };
  assistant: { id: string; name: string; color: string; description: string };
  redirectHost: string;
}

const GRANTS = [
  'Ask it questions and give it work, as you',
  'Read what it remembers and what your workspace knows',
  'Use the tools and integrations connected to it',
];

export default function AuthorizePage() {
  const [request, setRequest] = useState<Record<string, string>>();
  const [described, setDescribed] = useState<Described>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<'allow' | 'deny'>();

  useEffect(() => {
    const params = Object.fromEntries(new URLSearchParams(window.location.search));
    setRequest(params);
    api.get<Described>(`/api/oauth/authorize?${new URLSearchParams(params).toString()}`)
      .then(setDescribed)
      .catch((caught: unknown) => {
        if (caught instanceof ApiError && caught.status === 401) {
          const here = `${window.location.pathname}${window.location.search}`;
          window.location.replace(`/signin?returnTo=${encodeURIComponent(here)}`);
          return;
        }
        setError(caught instanceof Error ? caught.message : 'This request cannot be completed.');
      });
  }, []);

  async function decide(decision: 'allow' | 'deny') {
    if (request === undefined) return;
    setBusy(decision);
    try {
      const { redirectTo } = await api.post<{ redirectTo: string }>('/api/oauth/authorize', { decision, request });
      window.location.assign(redirectTo);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'This request cannot be completed.');
      setBusy(undefined);
    }
  }

  return (
    <div className="centered">
      <div className="panel consent">
        <div style={{ marginBottom: 18 }}><BrandMark /></div>

        {error !== undefined ? (
          <>
            <h2 style={{ margin: '0 0 6px', fontSize: 20 }}>This request cannot be completed</h2>
            <p className="muted" style={{ margin: 0 }}>{error}</p>
          </>
        ) : described === undefined ? (
          <Loader label="Checking the request…" />
        ) : (
          <>
            <div className="consent-who">
              <AgentAvatar color={described.assistant.color} size={48} />
              <div>
                <h2 style={{ margin: 0, fontSize: 20 }}>
                  Let <strong>{described.client.name}</strong> use {described.assistant.name}?
                </h2>
                <p className="muted" style={{ margin: '4px 0 0' }}>
                  In {described.workspace.name}. It will act as you, with what you can do.
                </p>
              </div>
            </div>

            <ul className="ticks">
              {GRANTS.map((line) => (
                <li key={line}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M5 12.5l4.2 4.2L19 7" />
                  </svg>
                  <span>{line}</span>
                </li>
              ))}
            </ul>

            <p className="faint" style={{ fontSize: 12.5, margin: '14px 0 18px' }}>
              You will be sent back to {described.redirectHost}. You can take this away at any time
              from the assistant’s Server tab.
            </p>

            <div className="consent-actions">
              <button type="button" className="ghost" disabled={busy !== undefined} onClick={() => void decide('deny')}>
                {busy === 'deny' ? 'Declining…' : 'Not now'}
              </button>
              <button type="button" className="primary" disabled={busy !== undefined} onClick={() => void decide('allow')}>
                {busy === 'allow' ? 'Allowing…' : `Allow ${described.client.name}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
