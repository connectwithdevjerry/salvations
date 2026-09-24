/**
 * The reply as it is being written, on the chat platform.
 *
 * A person on Telegram used to see nothing for the length of a run and then
 * the whole answer at once. Now the bot shows "typing…" for as long as it
 * works, posts the first words as soon as there are some, and rewrites that
 * one message as the rest arrives. The final delivery rewrites it a last time
 * with the persisted answer, so what stays in the chat is the record.
 *
 * Runs on the executor's own invocation, beside the run, reading the same
 * event stream the browser streams from. Best effort throughout: nothing
 * here may fail the run, and a platform that cannot edit gets typing only.
 */
import { channelTargetOf, isTarget, type ChannelTarget, type Draft } from './channel-delivery';
import { eventBus } from './singletons';

/** Telegram shows typing for about five seconds; renew before it lapses. */
const TYPING_EVERY_MS = 4_000;
/** Telegram tolerates roughly one edit a second per chat; stay under it. */
const EDIT_EVERY_MS = 1_400;
/** Enough words to be worth showing; a single token is a flicker. */
const FIRST_DRAFT_CHARS = 24;
const CURSOR = ' ▍';

export interface LiveReply {
  /** Stops typing and the stream. Returns the draft to rewrite, if one was posted. */
  close(): Promise<Draft | undefined>;
}

export async function openLiveReply(runId: string): Promise<LiveReply | undefined> {
  if (runId === '') return undefined;
  let target: ChannelTarget | { reason: string };
  try { target = await channelTargetOf(runId); } catch { return undefined; }
  if (!isTarget(target)) return undefined;
  return new Live(runId, target);
}

class Live implements LiveReply {
  readonly #runId: string;
  readonly #target: ChannelTarget;
  readonly #abort = new AbortController();
  readonly #typing: ReturnType<typeof setInterval>;
  #text = '';
  #draft: string | undefined;
  #lastEdit = 0;
  #shown = '';
  #editing: Promise<void> = Promise.resolve();
  #streaming: Promise<void>;

  constructor(runId: string, target: ChannelTarget) {
    this.#runId = runId;
    this.#target = target;
    void this.#indicate();
    this.#typing = setInterval(() => { void this.#indicate(); }, TYPING_EVERY_MS);
    this.#streaming = this.#follow().catch(() => undefined);
  }

  async close(): Promise<Draft | undefined> {
    clearInterval(this.#typing);
    this.#abort.abort();
    await this.#streaming;
    await this.#editing;
    return this.#draft === undefined ? undefined : { messageRef: this.#draft };
  }

  async #indicate(): Promise<void> {
    const { adapter, token, chatRef } = this.#target;
    if (adapter.indicate === undefined) return;
    await adapter.indicate(token, chatRef).catch(() => undefined);
  }

  async #follow(): Promise<void> {
    const { adapter } = this.#target;
    if (adapter.sendDraft === undefined || adapter.editDraft === undefined) return;
    const { bus } = await eventBus();
    for await (const event of bus.subscribe(this.#runId, this.#target.run.workspaceId, -1, this.#abort.signal)) {
      if (this.#abort.signal.aborted) return;
      if (event.type === 'text_delta') {
        const delta = (event.payload as { text?: unknown } | undefined)?.text;
        if (typeof delta === 'string') { this.#text += delta; this.#show(); }
      } else if (event.type === 'tool_call_started') {
        // Working, not writing: keep the indicator alive between words.
        void this.#indicate();
      }
    }
  }

  /** Posts or rewrites the draft, never more often than the platform likes. */
  #show(): void {
    const now = Date.now();
    if (now - this.#lastEdit < EDIT_EVERY_MS) return;
    if (this.#draft === undefined && this.#text.length < FIRST_DRAFT_CHARS) return;
    const text = this.#text;
    if (text === this.#shown) return;
    this.#lastEdit = now;
    this.#shown = text;
    const { adapter, token, chatRef } = this.#target;
    this.#editing = this.#editing.then(async () => {
      if (this.#draft === undefined) {
        this.#draft = await adapter.sendDraft?.(token, chatRef, `${text}${CURSOR}`);
      } else {
        await adapter.editDraft?.(token, chatRef, this.#draft, `${text}${CURSOR}`);
      }
    }).catch(() => undefined);
  }
}
