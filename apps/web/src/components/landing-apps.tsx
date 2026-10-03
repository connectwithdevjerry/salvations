'use client';

import { useState } from 'react';
import Link from 'next/link';
import { CATALOG, type CatalogEntry } from '@salvations/catalog';
import { Icon } from '@/components/ui';
import { AppDialog, AppPickerDialog } from '@/components/app-grid';

/**
 * "See all the apps", on the front door.
 *
 * The same picker the product uses, with no account behind it: every app on
 * its shelf, and one opens into what connecting it reads and changes. The
 * only button in it is the one that starts.
 */
export function LandingApps() {
  const entries = CATALOG.filter((e) => e.unavailable === undefined);
  const [browsing, setBrowsing] = useState(false);
  const [open, setOpen] = useState<CatalogEntry>();
  const none = { label: 'Not connected', tone: '' };

  return (
    <div className="land-apps">
      <button type="button" onClick={() => setBrowsing(true)}>
        <Icon name="grid" size={15} /> See all {entries.length} apps
      </button>

      {browsing && (
        <AppPickerDialog
          title={`${entries.length} apps, each reached directly`}
          lede="The places an assistant talks and the services it works in. No hub in between."
          entries={entries}
          statusOf={() => none}
          onPick={(entry) => { setBrowsing(false); setOpen(entry); }}
          onClose={() => setBrowsing(false)}
        />
      )}

      {open !== undefined && (
        <AppDialog entry={open} status={none} onClose={() => setOpen(undefined)}>
          <ul className="land-scopes">
            {open.scopes.map((scope) => (
              <li key={scope.scope}>
                <Icon name={scope.writes ? 'shield' : 'check'} size={15} />
                <span>{scope.label}{scope.writes ? '. Waits for your approval.' : ''}</span>
              </li>
            ))}
            {open.scopes.length === 0 && (
              <li><Icon name="check" size={15} /><span>{open.summary}</span></li>
            )}
          </ul>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <Link href="/signup"><button className="primary" type="button">Start free <Icon name="arrow" size={15} /></button></Link>
            {open.docs !== undefined && (
              <a href={open.docs} target="_blank" rel="noreferrer" className="land-ghost">The vendor&apos;s own docs</a>
            )}
            <button type="button" className="ghost" onClick={() => { setOpen(undefined); setBrowsing(true); }}>All apps</button>
          </div>
        </AppDialog>
      )}
    </div>
  );
}
