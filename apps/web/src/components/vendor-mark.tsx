/**
 * The two vendors a person can bring a key for, as cards rather than a list.
 *
 * Each is recognisable by its mark before its name is read. The marks are
 * drawn here, in the vendor's own colour, rather than pulled from a package:
 * two glyphs are not worth a dependency.
 */
import type { ReactNode } from 'react';
import { Icon } from '@/components/ui';

export interface VendorCopy {
  readonly label: string;
  readonly blurb: string;
  readonly keysAt: string;
  readonly keysUrl: string;
  readonly keyPrefix: string;
  /**
   * Whether this vendor can hear. Voice notes, on Telegram and in the Speak
   * tab, need a model that transcribes, and only some vendors offer one.
   */
  readonly voice: boolean;
}

export const VENDORS: Readonly<Record<string, VendorCopy>> = {
  anthropic: {
    label: 'Claude',
    blurb: 'Anthropic’s models. Strong at long, careful work and tool use.',
    keysAt: 'console.anthropic.com',
    keysUrl: 'https://console.anthropic.com/settings/keys',
    keyPrefix: 'sk-ant-…',
    voice: false,
  },
  openai: {
    label: 'OpenAI',
    blurb: 'GPT models, plus transcription and embeddings for voice and search.',
    keysAt: 'platform.openai.com',
    keysUrl: 'https://platform.openai.com/api-keys',
    keyPrefix: 'sk-…',
    voice: true,
  },
};

export const vendorCopy = (type: string): VendorCopy =>
  VENDORS[type] ?? { label: type, blurb: '', keysAt: 'your provider', keysUrl: '', keyPrefix: '', voice: false };

/** Said on a card and in the Model tab: what choosing this vendor means for voice. */
export const voiceNote = (type: string): string =>
  vendorCopy(type).voice
    ? 'Voice notes supported.'
    : `Voice notes are not available with ${vendorCopy(type).label}.`;

/** Claude's sunburst: eight rays in its terracotta. */
function ClaudeMark({ size }: { size: number }) {
  const rays: ReactNode[] = [];
  for (let i = 0; i < 8; i += 1) {
    rays.push(
      <rect
        key={i} x="-2.1" y="-16" width="4.2" height="13" rx="2.1"
        transform={`rotate(${i * 45})`}
      />,
    );
  }
  return (
    <svg viewBox="-18 -18 36 36" width={size} height={size} aria-hidden fill="#D97757">
      <g>{rays}</g>
      <circle r="3.6" />
    </svg>
  );
}

/** OpenAI's knot: six interlaced loops around a hexagon. */
function OpenAIMark({ size }: { size: number }) {
  const loops: ReactNode[] = [];
  for (let i = 0; i < 6; i += 1) {
    loops.push(
      <rect
        key={i} x="-4.4" y="-16.5" width="8.8" height="20" rx="4.4"
        transform={`rotate(${i * 60}) translate(0 3)`}
      />,
    );
  }
  return (
    <svg
      viewBox="-18 -18 36 36" width={size} height={size} aria-hidden
      fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round"
    >
      <g>{loops}</g>
    </svg>
  );
}

export function VendorMark({ type, size = 30 }: { type: string; size?: number }) {
  if (type === 'anthropic') return <ClaudeMark size={size} />;
  if (type === 'openai') return <OpenAIMark size={size} />;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

/**
 * What a page knows about a vendor's stored key.
 *
 * `ok` is the only state the word "connected" is allowed for: the vendor
 * accepted the key when it was last asked. A key that was stored before keys
 * were checked is `unknown`, and a key the vendor refused is `rejected`.
 */
export type KeyState = 'ok' | 'rejected' | 'unknown';

export interface KeyStates { readonly [providerType: string]: KeyState | undefined }

/** Reads the states off the provider list the server returns. */
export function keyStatesOf(
  items: readonly { providerType: string; lastCheck?: { ok: boolean } | undefined }[],
): KeyStates {
  const states: Record<string, KeyState> = {};
  for (const item of items) {
    const state: KeyState = item.lastCheck === undefined ? 'unknown' : item.lastCheck.ok ? 'ok' : 'rejected';
    // Several rows for one vendor: the best verdict wins, so one good key is
    // not hidden behind an older bad one.
    const current = states[item.providerType];
    if (current === undefined || current === 'unknown' || state === 'ok') states[item.providerType] = state;
  }
  return states;
}

const BADGE: Readonly<Record<KeyState, { text: string; className: string }>> = {
  ok: { text: 'Connected', className: 'badge ok' },
  rejected: { text: 'Key rejected', className: 'badge warn' },
  unknown: { text: 'Key not checked', className: 'badge' },
};

/**
 * Pick a vendor. Selection only: the form for the key lives below the cards,
 * so choosing is one tap and the page never turns into two forms.
 */
export function VendorCards({
  types, selected, keys = {}, onSelect,
}: {
  types: readonly string[];
  selected?: string;
  keys?: KeyStates;
  onSelect: (type: string) => void;
}) {
  return (
    <div className="vendor-grid" role="radiogroup" aria-label="AI provider">
      {types.map((type) => {
        const copy = vendorCopy(type);
        const isSelected = selected === type;
        const state = keys[type];
        const badge = state === undefined ? undefined : BADGE[state];
        return (
          <button
            key={type}
            type="button"
            role="radio"
            aria-checked={isSelected}
            className={isSelected ? 'vendor-card selected' : 'vendor-card'}
            onClick={() => onSelect(type)}
          >
            <span className="vendor-mark" aria-hidden><VendorMark type={type} size={30} /></span>
            <span className="vendor-name">
              {copy.label}
              {badge !== undefined && <span className={badge.className}>{badge.text}</span>}
            </span>
            <span className="vendor-blurb">{copy.blurb}</span>
            <span className={copy.voice ? 'vendor-note' : 'vendor-note off'}>
              <Icon name="mic" size={13} /> {voiceNote(type)}
            </span>
            <span className="vendor-tick" aria-hidden>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12.5l4.2 4.2L19 7" />
              </svg>
            </span>
          </button>
        );
      })}
    </div>
  );
}
