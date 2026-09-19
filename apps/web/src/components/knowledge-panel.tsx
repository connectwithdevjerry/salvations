'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ws } from '@/lib/client/api';
import { Icon, Tile } from '@/components/ui';
import { Loader } from '@/components/loader';

/**
 * Knowledge.
 *
 * The business context: what every agent in this workspace should know. It
 * comes first — before an agent exists — because an agent with nothing to
 * draw on answers from general knowledge, and general knowledge does not know
 * this business's prices.
 *
 * Two ways in, because people have both: a file they already have, and a
 * paragraph they would rather type than make a file of. Both become the same
 * kind of thing once stored.
 *
 * A "try a question" box, because somebody who has just uploaded a document
 * wants to see it is findable before trusting an agent to find it.
 */

interface Doc {
  id: string; title: string; fileName: string; mimeType: string; sizeBytes: number;
  status: 'ingesting' | 'ready' | 'failed'; error?: string; chunkCount: number;
  embedded: boolean; createdAt: string;
}
interface Hit { documentId: string; title: string; index: number; content: string; score: number }

const ACCEPT = '.txt,.md,.markdown,.html,.htm,.csv,.tsv,.json,text/plain,text/markdown,text/html,text/csv,application/json';

/**
 * Rendered on its own page and inside an assistant's Documents tab. Knowledge
 * is shared, and the tab says so rather than pretending each assistant has
 * its own.
 */
export function KnowledgePanel({ workspaceId, embedded = false }: { workspaceId: string; embedded?: boolean }) {
  const [docs, setDocs] = useState<Doc[]>();
  const [embedding, setEmbedding] = useState<boolean>();
  const [error, setError] = useState<string>();

  const reload = useCallback(() => {
    api.get<{ items: Doc[]; embeddingConfigured: boolean }>(`${ws(workspaceId)}/knowledge`)
      .then((r) => { setDocs(r.items); setEmbedding(r.embeddingConfigured); })
      .catch((e: Error) => { setError(e.message); setDocs([]); });
  }, [workspaceId]);

  useEffect(() => { reload(); }, [reload]);

  const ready = (docs ?? []).filter((d) => d.status === 'ready');

  return (
    <div className="page">
      {embedded ? (
        <p className="muted" style={{ margin: '0 0 16px' }}>
          Shared by every assistant in this workspace. Anything added here, every one of them can
          search.
        </p>
      ) : (
        <header>
          <h2>Knowledge</h2>
          <p className="lede">
            What your assistants should know about this business — policies, prices, products,
            how things are done. Every assistant you create draws on all of it.
          </p>
        </header>
      )}

      {error !== undefined && <p className="error">{error}</p>}

      <div className="two-up">
        <div className="card">
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
            <Tile name="book" />
            <div>
              <strong>Upload a document</strong>
              <p className="muted" style={{ margin: '2px 0 0' }}>
                Text, Markdown, HTML, CSV or JSON. Export a PDF or Word file as one of those first.
              </p>
            </div>
          </div>
          <UploadForm workspaceId={workspaceId} onDone={reload} onError={setError} />
        </div>

        <div className="card">
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
            <Tile name="chat" />
            <div>
              <strong>Write it in</strong>
              <p className="muted" style={{ margin: '2px 0 0' }}>A paragraph or a page, typed straight in.</p>
            </div>
          </div>
          <TextForm workspaceId={workspaceId} onDone={reload} onError={setError} />
        </div>
      </div>

      {embedding === false && (docs?.length ?? 0) > 0 && (
        <div className="note" style={{ marginTop: 14 }}>
          <span className="tile" aria-hidden><Icon name="spark" size={16} /></span>
          <span>
            Search is by keyword for now. Bind a model to the <strong>embedding</strong> role on
            the Models page and agents will also find passages that say the same thing in
            different words.
          </span>
        </div>
      )}

      {docs === undefined && <Loader inline label="Loading documents" />}

      {docs !== undefined && docs.length > 0 && (
        <>
          <p className="eyebrow" style={{ marginTop: 26 }}>
            {docs.length} {docs.length === 1 ? 'document' : 'documents'}
          </p>
          {docs.map((doc) => (
            <DocRow key={doc.id} workspaceId={workspaceId} doc={doc} onChanged={reload} onError={setError} />
          ))}
        </>
      )}

      {docs?.length === 0 && (
        <p className="muted" style={{ marginTop: 20 }}>
          Nothing uploaded yet. Start with the things people ask about most.
        </p>
      )}

      {ready.length > 0 && <TrySearch workspaceId={workspaceId} />}
    </div>
  );
}

function DocRow({
  workspaceId, doc, onChanged, onError,
}: {
  workspaceId: string; doc: Doc; onChanged: () => void; onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const kb = Math.max(1, Math.round(doc.sizeBytes / 1024));

  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', gap: 12, minWidth: 0 }}>
          <Tile name="book" />
          <div style={{ minWidth: 0 }}>
            <strong>{doc.title}</strong>
            {doc.status === 'failed' && <span className="badge danger" style={{ marginLeft: 8 }}>failed</span>}
            {doc.status === 'ingesting' && <span className="badge" style={{ marginLeft: 8 }}>reading…</span>}
            <p className="muted" style={{ margin: '3px 0 0' }}>
              <span className="mono">{doc.fileName}</span> · {kb} KB
              {doc.status === 'ready' && ` · ${doc.chunkCount} ${doc.chunkCount === 1 ? 'part' : 'parts'}`}
              {doc.status === 'ready' && !doc.embedded && ' · keyword search only'}
            </p>
            {doc.error !== undefined && (
              <p className="muted" style={{ margin: '4px 0 0', color: 'var(--danger)' }}>{doc.error}</p>
            )}
          </div>
        </div>
        <div style={{ textAlign: 'right', flex: 'none' }}>
          <p className="faint" style={{ margin: 0 }}>{new Date(doc.createdAt).toLocaleDateString()}</p>
          {doc.status === 'ready' && (
            <a href={`${ws(workspaceId)}/knowledge/${doc.id}/download`} download={doc.fileName}>
              <button type="button" style={{ marginTop: 8, marginRight: 6 }}>Download</button>
            </a>
          )}
          <button
            type="button" className="danger" disabled={busy} style={{ marginTop: 8 }}
            onClick={async () => {
              setBusy(true);
              try {
                await api.del(`${ws(workspaceId)}/knowledge/${doc.id}`);
                onChanged();
              } catch (caught) {
                onError(caught instanceof Error ? caught.message : 'Could not delete that.');
              } finally { setBusy(false); }
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function UploadForm({
  workspaceId, onDone, onError,
}: {
  workspaceId: string; onDone: () => void; onError: (m: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File>();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        if (file === undefined) return;
        setBusy(true);
        onError('');
        const form = new FormData();
        form.set('file', file);
        if (title.trim() !== '') form.set('title', title.trim());
        try {
          const result = await api.upload<{ duplicate: boolean; title: string }>(`${ws(workspaceId)}/knowledge`, form);
          if (result.duplicate) onError(`“${result.title}” was already uploaded — the same content is stored once.`);
          setFile(undefined);
          setTitle('');
          if (input.current !== null) input.current.value = '';
          onDone();
        } catch (caught) {
          onError(caught instanceof Error ? caught.message : 'Could not upload that.');
        } finally { setBusy(false); }
      }}
    >
      <div>
        <label htmlFor="knowledgeFile">File</label>
        <input
          id="knowledgeFile" ref={input} type="file" accept={ACCEPT} required
          onChange={(e) => {
            const chosen = e.target.files?.[0];
            setFile(chosen);
            if (chosen !== undefined && title === '') setTitle('');
          }}
        />
      </div>
      <div>
        <label htmlFor="knowledgeTitle">Title <span className="faint">(optional)</span></label>
        <input
          id="knowledgeTitle" placeholder={file === undefined ? 'From the file name' : file.name.replace(/\.[a-z0-9]+$/i, '')}
          value={title} onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <button className="primary" type="submit" disabled={busy || file === undefined}>
        {busy ? 'Reading…' : 'Add to knowledge'}
      </button>
    </form>
  );
}

function TextForm({
  workspaceId, onDone, onError,
}: {
  workspaceId: string; onDone: () => void; onError: (m: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        onError('');
        try {
          await api.post(`${ws(workspaceId)}/knowledge`, { title, text });
          setTitle('');
          setText('');
          onDone();
        } catch (caught) {
          onError(caught instanceof Error ? caught.message : 'Could not save that.');
        } finally { setBusy(false); }
      }}
    >
      <div>
        <label htmlFor="noteTitle">Title</label>
        <input
          id="noteTitle" required placeholder="Refund policy"
          value={title} onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div>
        <label htmlFor="noteText">Text</label>
        <textarea
          id="noteText" required rows={5}
          placeholder="Full refund within 30 days of purchase. After that, store credit…"
          value={text} onChange={(e) => setText(e.target.value)}
        />
      </div>
      <button className="primary" type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Add to knowledge'}
      </button>
    </form>
  );
}

function TrySearch({ workspaceId }: { workspaceId: string }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>();
  const [busy, setBusy] = useState(false);

  return (
    <div style={{ marginTop: 30 }}>
      <p className="eyebrow">Try a question</p>
      <p className="muted" style={{ margin: '0 0 10px' }}>
        The same search your agents run. If it finds the right passage here, they will too.
      </p>
      <form
        className="row" style={{ gap: 8 }}
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            const r = await api.get<{ items: Hit[] }>(
              `${ws(workspaceId)}/knowledge/search?q=${encodeURIComponent(query)}`,
            );
            setHits(r.items);
          } catch {
            setHits([]);
          } finally { setBusy(false); }
        }}
      >
        <input
          aria-label="Question" placeholder="What is the refund policy?"
          value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: 1 }}
        />
        <button type="submit" disabled={busy || query.trim() === ''}>Search</button>
      </form>

      {hits !== undefined && (
        <div style={{ marginTop: 12 }}>
          {hits.length === 0 && <p className="muted">Nothing matched. Try the words a document would actually use.</p>}
          {hits.map((hit) => (
            <div key={`${hit.documentId}-${hit.index}`} className="card">
              <p className="faint" style={{ margin: '0 0 6px' }}>
                {hit.title} · part {hit.index + 1}
              </p>
              <p style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 13.5 }}>{hit.content}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
