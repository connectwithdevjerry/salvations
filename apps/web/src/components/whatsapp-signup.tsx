'use client';

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import type { CatalogEntry } from '@salvations/catalog';
import { api, ws } from '@/lib/client/api';
import { OneClickConnect } from '@/components/one-click-connect';

/**
 * Meta's Embedded Signup, from the browser.
 *
 * Meta has no redirect for this: its JavaScript SDK opens a window where
 * the person picks or creates their WhatsApp Business account and number,
 * then hands two things back to this page. A message event names the phone
 * number id and the Messaging account id; the login callback carries a
 * code good for thirty seconds. Both go to the server in one request, at
 * once, and the server does the rest.
 *
 * The SDK is loaded only when the person presses the button, from Meta's
 * own host, and talks to Meta alone: it is Meta's consent screen in a
 * window rather than on a redirect, and nothing of the person's passes
 * through anyone else.
 */

export interface WhatsAppSignupConfig { readonly appId: string; readonly configId: string; readonly version: string }

interface SignupMessage { type?: string; event?: string; data?: { phone_number_id?: string; waba_id?: string } }

interface FacebookSdk {
  init: (options: { appId: string; version: string; xfbml?: boolean; autoLogAppEvents?: boolean }) => void;
  login: (
    callback: (response: { authResponse?: { code?: string } | null }) => void,
    options: { config_id: string; response_type: 'code'; override_default_response_type: true; extras: { setup: Record<string, never> } },
  ) => void;
}

declare global {
  interface Window { FB?: FacebookSdk; fbAsyncInit?: () => void }
}

const SDK_URL = 'https://connect.facebook.net/en_US/sdk.js';

/** Loads Meta's SDK once and initialises it for this app. */
function loadSdk(config: WhatsAppSignupConfig): Promise<FacebookSdk> {
  return new Promise((resolve, reject) => {
    if (window.FB !== undefined) { resolve(window.FB); return; }
    window.fbAsyncInit = () => {
      if (window.FB === undefined) { reject(new Error('Meta\'s SDK loaded without FB.')); return; }
      window.FB.init({ appId: config.appId, version: config.version, xfbml: false, autoLogAppEvents: false });
      resolve(window.FB);
    };
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => reject(new Error('Meta\'s sign-up script could not be loaded. A content blocker may be stopping it.'));
    document.head.appendChild(script);
  });
}

/**
 * The button's behaviour: a function that runs the whole sign-up and
 * resolves once the server has connected the number.
 */
export function useWhatsAppSignup({
  workspaceId, agentId, config, onDone,
}: {
  workspaceId: string;
  agentId: string;
  config: WhatsAppSignupConfig;
  onDone: () => void;
}): () => Promise<void> {
  // What Meta's window said about the account, kept until the code arrives.
  const heard = useRef<{ phoneNumberId?: string; wabaId?: string }>({});

  useEffect(() => {
    const listen = (event: MessageEvent) => {
      if (typeof event.origin !== 'string' || !event.origin.endsWith('facebook.com')) return;
      if (typeof event.data !== 'string') return;
      let message: SignupMessage;
      try { message = JSON.parse(event.data) as SignupMessage; } catch { return; }
      if (message.type !== 'WA_EMBEDDED_SIGNUP' || message.data === undefined) return;
      heard.current = {
        ...(message.data.phone_number_id !== undefined ? { phoneNumberId: message.data.phone_number_id } : {}),
        ...(message.data.waba_id !== undefined ? { wabaId: message.data.waba_id } : {}),
      };
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, []);

  return useCallback(async () => {
    const sdk = await loadSdk(config);
    heard.current = {};
    const code = await new Promise<string>((resolve, reject) => {
      sdk.login((response) => {
        const got = response.authResponse?.code;
        if (typeof got === 'string' && got !== '') resolve(got);
        else reject(new Error('Meta\'s window closed before the number was connected. Nothing was changed.'));
      }, {
        config_id: config.configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {} },
      });
    });
    // The code lasts thirty seconds, so it goes now, with whatever the
    // window said about which number this is.
    await api.post(`${ws(workspaceId)}/channels/whatsapp/install`, {
      agentId, code, ...heard.current,
    });
    onDone();
  }, [workspaceId, agentId, config, onDone]);
}

/** The one-press card for WhatsApp, with Meta's window behind the button. */
export function WhatsAppInstall({
  workspaceId, agentId, entry, config, onChanged, onError, children,
}: {
  workspaceId: string;
  agentId: string;
  entry: CatalogEntry;
  config: WhatsAppSignupConfig;
  onChanged: () => void;
  onError: (message: string | undefined) => void;
  children: ReactNode;
}) {
  const start = useWhatsAppSignup({ workspaceId, agentId, config, onDone: onChanged });
  return (
    <OneClickConnect workspaceId={workspaceId} agentId={agentId} entry={entry} onError={onError} start={start}>
      {children}
    </OneClickConnect>
  );
}
