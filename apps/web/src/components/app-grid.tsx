'use client';

import { useState, type ReactNode } from 'react';
import { CATEGORIES, searchCatalog, type CatalogEntry } from '@salvations/catalog';
import { api, ws } from '@/lib/client/api';
import { Icon } from '@/components/ui';
import { useDialog } from '@/components/dialog';

/**
 * The app picker.
 *
 * A grid of everything an assistant can be connected to, searchable, on
 * shelves. Each card is a service reached directly: HIVE's own adapters, or
 * the vendor's own MCP server at the vendor's documented address. There is
 * no third-party hub behind this grid, which is why its count is honest
 * rather than large.
 */

export interface AppStatus { readonly label: string; readonly tone: string }

export function AppGrid({
  entries, statusOf, onPick, footer, compact = false,
}: {
  entries: readonly CatalogEntry[];
  statusOf: (entry: CatalogEntry) => AppStatus;
  onPick: (entry: CatalogEntry) => void;
  footer?: ReactNode;
  /** The wizard shows the first shelf or two; "Browse all" opens the rest. */
  compact?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [all, setAll] = useState(!compact);
  const matching = searchCatalog(entries, query);
  const searching = query.trim() !== '';
  const shown = searching || all ? matching : matching.slice(0, 8);

  const shelves = searching || !all
    ? [{ name: undefined, entries: shown }]
    : CATEGORIES.map((name) => ({ name, entries: shown.filter((e) => e.category === name) })).filter((s) => s.entries.length > 0);

  return (
    <div className="apps">
      <div className="apps-bar">
        <label className="search apps-search">
          <Icon name="search" size={15} />
          <input
            type="search" placeholder={`Search ${entries.length} apps`} aria-label="Search apps"
            value={query} onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {!all && !searching && (
          <button type="button" onClick={() => setAll(true)}>Browse all {entries.length} apps</button>
        )}
      </div>

      {shelves.map((shelf) => (
        <div key={shelf.name ?? 'all'} className="apps-shelf">
          {shelf.name !== undefined && <p className="eyebrow">{shelf.name}</p>}
          <div className="app-grid">
            {shelf.entries.map((entry) => {
              const status = statusOf(entry);
              return (
                <button key={entry.id} type="button" className="app-card" onClick={() => onPick(entry)}>
                  <span className="app-tile" style={{ ['--accent-brand' as string]: entry.accent }} aria-hidden>
                    {entry.name.charAt(0)}
                  </span>
                  <span className="app-copy">
                    <span className="app-name">{entry.name}</span>
                    <span className="app-cat">{entry.category}</span>
                  </span>
                  {status.label !== 'Not connected' && (
                    <span className={`app-status ${status.tone}`} title={status.label}>{status.label}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {shown.length === 0 && <p className="muted">Nothing matches “{query}”. Ask for it below.</p>}
      {footer}
    </div>
  );
}

/** The panel one app opens into. Escape or the backdrop closes it. */
export function AppDialog({
  entry, status, onClose, children,
}: {
  entry: CatalogEntry;
  status: AppStatus;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="dialog wide app-dialog" role="dialog" aria-modal="true" aria-labelledby="app-dialog-title">
        <div className="app-dialog-head">
          <span className="app-tile" style={{ ['--accent-brand' as string]: entry.accent }} aria-hidden>{entry.name.charAt(0)}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 id="app-dialog-title" style={{ margin: 0 }}>{entry.name}</h3>
            <p className="muted" style={{ margin: '2px 0 0' }}>{entry.summary}</p>
          </div>
          <span className={`badge ${status.tone}`}>{status.label}</span>
          <button type="button" className="ghost" aria-label="Close" onClick={onClose}><Icon name="exit" size={16} /></button>
        </div>
        <div className="app-dialog-body">{children}</div>
      </div>
    </div>
  );
}

/**
 * "Don't see a tool you need?"
 *
 * A request is written to the workspace's audit trail, where the admin
 * dashboard shows it. It is a message to whoever runs this deployment,
 * not a promise.
 */
export function RequestCard({ workspaceId }: { workspaceId: string }) {
  const dialog = useDialog();
  const [sent, setSent] = useState<string>();
  return (
    <div className="request-card">
      <div>
        <strong>Don&apos;t see a tool you need?</strong>
        <p className="muted" style={{ margin: '3px 0 0' }}>
          {sent === undefined ? 'Requests shape what is added next.' : `Asked for ${sent}. Noted.`}
        </p>
      </div>
      <button
        type="button"
        onClick={async () => {
          const name = await dialog.prompt({ title: 'Which tool?', label: 'Name of the app or service', placeholder: 'e.g. Xero', maxLength: 80 });
          if (name === undefined) return;
          try {
            await api.post(`${ws(workspaceId)}/integrations/requests`, { name });
            setSent(name);
          } catch (caught) {
            await dialog.notice({ title: 'Could not send that', body: caught instanceof Error ? caught.message : undefined });
          }
        }}
      >
        Request an integration
      </button>
    </div>
  );
}
