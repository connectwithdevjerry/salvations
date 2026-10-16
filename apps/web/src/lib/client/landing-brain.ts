/**
 * What the front door's voice demo knows.
 *
 * A scripted brain, not a model: it runs in the visitor's browser, costs
 * nothing, and needs no key, which is the only honest way to let a
 * stranger talk to the page. It knows this page and nothing else, and
 * says so when asked something else. Every answer is short, because it
 * is read out loud.
 */
import { CATALOG, CHANNELS, PLANS, ROLES } from '@salvations/catalog';

const plan = PLANS[0];
const price = plan === undefined ? 'a monthly subscription' : `$${Math.round(plan.amountCents / 100)} a month`;
const integrations = CATALOG.filter((e) => e.kind === 'integration' && e.unavailable === undefined);
const channelNames = CHANNELS.map((c) => c.name);
const roleNames = ROLES.map((r) => r.name.toLowerCase());

const list = (items: readonly string[]): string =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

interface Answer { readonly when: RegExp; readonly say: string }

const ANSWERS: readonly Answer[] = [
  {
    when: /\b(hi|hello|hey|good (morning|afternoon|evening))\b/i,
    say: 'Hello. I am the demo on this page. Ask me what HIVE costs, where it talks to you, what it connects to, or how it keeps your data.',
  },
  {
    when: /\b(price|pricing|cost|how much|pay|subscription|trial|free)\b/i,
    say: `${price} for the workspace, with ten days free and no card to start. Your own Claude or OpenAI key is on top, and you pay that provider directly.`,
  },
  {
    when: /\b(telegram|whatsapp|imessage|slack|discord|channel|text|message|chat|phone|where)\b/i,
    say: `Wherever you already are: ${list(channelNames)}, here in the browser, out loud, and from Claude.ai or ChatGPT. Same assistant, same memory, everywhere.`,
  },
  {
    when: /\b(integrat|connect|gmail|calendar|github|notion|linear|tools?|apps?|email|mail)\b/i,
    say: `${integrations.length} apps, each on the vendor's own consent screen: Gmail, Calendar, Drive, GitHub, Notion, Linear and more. And any MCP server you point it at.`,
  },
  {
    when: /\b(secur|safe|privacy|private|data|key|database|trust)\b/i,
    say: 'Your own API key, your own database, nothing in between. Before it sends, deletes or pays for anything, it stops and asks you. Everything it did stays in Activity.',
  },
  {
    when: /\b(approv|permission|ask|control|stop)\b/i,
    say: 'It asks before anything it cannot undo, here or right in the chat. One tap approves, one more says never ask again. Rules you write decide what runs, what asks and what never runs.',
  },
  {
    when: /\b(team|role|assistant|agent|marketing|sales|support|finance|academic|manager|research)\b/i,
    say: `A team of ${roleNames.length}: ${list(roleNames.slice(0, 5))} and more. Each knows its job on day one.`,
  },
  {
    when: /\b(voice|speak|talk|listen|hear|out loud)\b/i,
    say: 'This is the demo: your browser hears you, I answer from the page, your browser reads it back. The real Speak tab runs on your own OpenAI key and does real work.',
  },
  {
    when: /\b(what (is|are|does)|what's) (hive|this|it)\b|\babout hive\b|\bwhat (do|does) (you|it|hive) do\b|\btell me about\b/i,
    say: 'HIVE is a team of assistants that read your documents, work in your tools, answer where you text, and stop to ask before anything consequential. Ask once, get finished work back.',
  },
  {
    when: /\b(start|sign ?up|begin|try|get started|how do i)\b/i,
    say: 'Press Start free at the top. Ten days, no card. The one-minute walkthrough runs on your first visit.',
  },
  {
    when: /\b(who (made|built)|yashayah|company)\b/i,
    say: 'HIVE is made by Yashayah. Everything here is built to run on your keys and your data.',
  },
];

export const FALLBACK = 'I am only the demo, and I only know this page. Ask me what HIVE costs, where it talks to you, what it connects to, or how it keeps your data.';

/** The scripted answer to what was heard. */
export function answerFor(heard: string): string {
  const text = heard.trim();
  if (text === '') return FALLBACK;
  return ANSWERS.find((a) => a.when.test(text))?.say ?? FALLBACK;
}
