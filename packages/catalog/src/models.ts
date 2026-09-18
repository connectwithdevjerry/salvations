/**
 * The models this deployment can offer, named.
 *
 * Hard-coded for the same reason the integrations are: typing a model id into a
 * free-text box is the "paste a URL and hope" problem, and the cost of getting
 * it wrong is worse here — an unrecognised id still RUNS, on a fallback profile
 * with a 200K window, so the only symptom is conversations being truncated
 * early for no visible reason.
 *
 * Two rules keep this list honest.
 *
 * Every entry must be one its adapter has a real capability profile for. A
 * catalogue that offers a model the adapter cannot describe is a catalogue that
 * silently lies about context windows; `models.test.ts` in the provider
 * registry asserts the two never drift.
 *
 * Rates are OPTIONAL, and absent means absent. Budgets are enforced against
 * these numbers, so a made-up price is not a small inaccuracy — it is a budget
 * that stops a run too early or too late and looks correct while doing it.
 * Where a rate is given it carries the date it was checked; where none could be
 * stated, the UI asks for it and says why.
 */

export type ModelRole = 'chat' | 'reasoning' | 'summarizer' | 'cheap' | 'embedding' | 'transcription';

export interface ModelRates {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheReadPerMTok?: number;
  /**
   * When these numbers were last checked, and against what.
   *
   * Shown in the UI. A price with no date is a price nobody can judge the age
   * of, and these change.
   */
  readonly checkedOn: string;
  /**
   * Set when the rate is promotional and will rise on a known date.
   *
   * Encoded rather than ignored, because the failure is silent: a budget set on
   * an introductory rate keeps reporting the old cost after it ends, and spend
   * quietly exceeds what the workspace agreed to.
   */
  readonly introductoryUntil?: string;
}

export interface CatalogModel {
  /** The id sent to the vendor. Must match a profile in that adapter. */
  readonly id: string;
  readonly providerType: string;
  readonly displayName: string;
  /** One line: what it is FOR, not what it is. */
  readonly summary: string;
  /** Roles this model is a sensible default for. */
  readonly roles: readonly ModelRole[];
  /** Absent when no rate could be stated honestly. */
  readonly rates?: ModelRates;
  /**
   * Set when the rate is not per token at all.
   *
   * Transcription is usually billed per minute of audio. Presenting that as a
   * $/Mtok figure would be wrong by orders of magnitude in whichever direction
   * the conversion was guessed.
   */
  readonly billedDifferently?: string;
}

/**
 * Two vendors, by decision. The person connects their own Claude or OpenAI key;
 * HIVE holds no key and bills nobody for inference.
 */

/** Checked against the vendor's own pricing page on this date. */
const ANTHROPIC_CHECKED = '2026-06-24';
const OPENAI_CHECKED = '2026-09-18';

const ANTHROPIC: readonly CatalogModel[] = [
  {
    id: 'claude-opus-5',
    providerType: 'anthropic',
    displayName: 'Claude Opus 5',
    summary: 'The default. Strong at everything, 1M context.',
    roles: ['chat', 'reasoning'],
    rates: { inputPerMTok: 5, outputPerMTok: 25, checkedOn: ANTHROPIC_CHECKED },
  },
  {
    id: 'claude-sonnet-5',
    providerType: 'anthropic',
    displayName: 'Claude Sonnet 5',
    summary: 'Most of the capability at under half the price.',
    roles: ['chat'],
    rates: { inputPerMTok: 2, outputPerMTok: 10, checkedOn: ANTHROPIC_CHECKED },
  },
  {
    id: 'claude-haiku-4-5',
    providerType: 'anthropic',
    displayName: 'Claude Haiku 4.5',
    summary: 'Fast and cheap, for the small mechanical calls. 200K context.',
    roles: ['cheap', 'summarizer'],
    rates: { inputPerMTok: 1, outputPerMTok: 5, checkedOn: ANTHROPIC_CHECKED },
  },
  {
    id: 'claude-opus-4-8',
    providerType: 'anthropic',
    displayName: 'Claude Opus 4.8',
    summary: 'The previous Opus generation, same price as the current one.',
    roles: ['chat', 'reasoning'],
    rates: { inputPerMTok: 5, outputPerMTok: 25, checkedOn: ANTHROPIC_CHECKED },
  },
  {
    id: 'claude-fable-5-1',
    providerType: 'anthropic',
    displayName: 'Claude Fable 5.1',
    summary: 'The most capable, for work worth paying for. Reasoning is always on.',
    roles: ['reasoning'],
    rates: { inputPerMTok: 10, outputPerMTok: 50, checkedOn: ANTHROPIC_CHECKED },
  },
];

const OPENAI: readonly CatalogModel[] = [
  {
    id: 'gpt-5.6-sol',
    providerType: 'openai',
    displayName: 'GPT-5.6 Sol',
    summary: 'The flagship. Strong at reasoning and long-horizon work.',
    roles: ['chat', 'reasoning'],
    // The published short-context rate. Long-context requests are billed
    // higher, so a workspace running near the window will see more than this —
    // stated rather than averaged into a number that is wrong at both ends.
    rates: { inputPerMTok: 5, outputPerMTok: 30, checkedOn: OPENAI_CHECKED },
  },
  {
    id: 'gpt-5',
    providerType: 'openai',
    displayName: 'GPT-5',
    summary: 'The previous flagship.',
    roles: ['chat'],
  },
  {
    id: 'gpt-4.1',
    providerType: 'openai',
    displayName: 'GPT-4.1',
    summary: 'Older, still capable, often cheaper.',
    roles: ['cheap', 'summarizer'],
  },
  {
    id: 'gpt-4o',
    providerType: 'openai',
    displayName: 'GPT-4o',
    summary: 'Older multimodal model.',
    roles: ['cheap'],
  },
];

export const CATALOG_MODELS: readonly CatalogModel[] = [...ANTHROPIC, ...OPENAI];

export const modelsFor = (providerType: string): readonly CatalogModel[] =>
  CATALOG_MODELS.filter((model) => model.providerType === providerType);

export const catalogModel = (id: string): CatalogModel | undefined =>
  CATALOG_MODELS.find((model) => model.id === id);

/**
 * What to bind when somebody connects a provider and says nothing else.
 *
 * Connecting a key should leave a workspace able to run, not facing five
 * binding forms. The chat role is the one that must exist — an agent naming no
 * role gets it — so a vendor with nothing suggested for chat is not offered as
 * a one-click setup at all.
 */
export function defaultBindings(providerType: string): readonly { role: ModelRole; model: CatalogModel }[] {
  const available = modelsFor(providerType);
  const out: { role: ModelRole; model: CatalogModel }[] = [];

  for (const role of ['chat', 'cheap', 'summarizer'] as const) {
    // First match wins, and the list is ordered best-first per vendor.
    const model = available.find((candidate) => candidate.roles.includes(role));
    if (model !== undefined) out.push({ role, model });
  }

  return out;
}

/** Whether a rate has stopped being the promotional one it was recorded at. */
export function rateHasExpired(rates: ModelRates | undefined, now = new Date()): boolean {
  if (rates?.introductoryUntil === undefined) return false;
  return now > new Date(rates.introductoryUntil);
}
