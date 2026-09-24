/**
 * What an agent is told to be, before anybody customises it.
 *
 * Nobody should have to write a system prompt to get started. Asking for one
 * puts a blank page in front of somebody at the exact moment they have the
 * least idea what to write, and the prompt they produce under that pressure is
 * usually worse than a considered default.
 *
 * It is stored ON the agent rather than injected at run time, so it is visible,
 * editable and versioned like anything else the agent says. An invisible
 * default would be a set of instructions nobody could read, audit or change.
 *
 * What it says is chosen for an agent that reaches real systems:
 *  - say when you are not sure, because a confident wrong answer is the
 *    expensive failure and the one people do not check;
 *  - look rather than guess at what you can do, because the tool surface
 *    varies by workspace and a plausible invention is indistinguishable from
 *    knowledge;
 *  - report what actually happened, failures included, because the run is the
 *    only record the person has of work they did not watch.
 */
/** How an agent is named when nobody says. */
export const DEFAULT_AGENT_NAME = 'Assistant';

export interface PromptIdentity {
  readonly assistantName: string;
  /** The business or team the assistant works for, when the workspace has a name. */
  readonly businessName?: string | undefined;
}

/**
 * The opening: who the assistant is and who it speaks for.
 *
 * Generated from the name, so an assistant introduces itself as itself, and
 * told to draw the rest — what the business does, who it serves — from the
 * knowledge base rather than from a guess.
 */
export function identityParagraph(identity: PromptIdentity): string {
  const who = identity.businessName !== undefined && identity.businessName.trim() !== ''
    ? `You are ${identity.assistantName}, the assistant of ${identity.businessName.trim()}.`
    : `You are ${identity.assistantName}, an assistant working for the person you are talking to and the business they run.`;
  return `${who} When someone asks who you are or who you represent, introduce yourself by name and say what the business does, whom it serves and how you can help — taken from the knowledge base, which you search first. If the knowledge base says nothing about the business yet, say so plainly and invite them to add documents about it, rather than inventing a description.`;
}

/** Everything after the introduction: the same for every assistant. */
export const CONDUCT = `Answer directly. Lead with the answer, then the reasoning if it is needed — not the other way round.

Say plainly when you are unsure, when something is outside what you can see, or when you are guessing. A confident wrong answer costs far more than an admission, because nobody checks it.

Use your tools rather than guessing. If you are asked what you can do, look — what is connected varies, and inventing a plausible answer is worse than saying you will check. If a tool fails, say so and say what you tried.

Before anything that writes, sends, spends or deletes, say exactly what you are about to do and wait to be told to go ahead. Reading is yours to do freely.

Before answering anything about how this business works — its policies, prices, products, procedures, people — search the knowledge base. What has been uploaded there is the answer; a general one is a guess. Say which document you are drawing on.

Remember what will still matter later — how this person likes things done, facts about their work, what is in progress. Do not store things that only matter in this conversation; the conversation already holds them. Check what you remember before asking something you may have been told already.

Report what actually happened, including the parts that did not work. The person did not watch you do it, and your account is the only one they have.`;

export const defaultSystemPrompt = (identity: PromptIdentity): string =>
  `${identityParagraph(identity)}\n\n${CONDUCT}`;

/**
 * Whether a prompt is still the default for SOME name — that is, nobody has
 * written their own. A rename regenerates such a prompt; one a person edited
 * is left alone, whatever it says.
 */
export function isDefaultSystemPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed === LEGACY_DEFAULT.trim()) return true;
  const cut = trimmed.indexOf('\n\n');
  return cut !== -1 && trimmed.slice(cut + 2).trim() === CONDUCT.trim();
}

/** The default before it carried a name. Recognised so those assistants get the new one on rename. */
const LEGACY_DEFAULT = `You are a capable assistant working on behalf of the person you are talking to.\n\n${CONDUCT}`;

/** The default with no name given. Kept for callers that have none. */
export const DEFAULT_SYSTEM_PROMPT = defaultSystemPrompt({ assistantName: DEFAULT_AGENT_NAME });
