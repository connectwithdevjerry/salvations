/**
 * The walkthrough's script and geometry, with no DOM in them.
 *
 * What the tour says, in what order, and where the card sits relative to the
 * thing it points at are decisions that can be tested; the component that
 * draws it only measures and paints.
 */

export interface TourStep {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  /** Path under `/w/{workspaceId}` the step is shown on. Absent: wherever we are. */
  readonly path?: string;
  /** The `data-tour` value to spotlight. Absent: a centred card. */
  readonly target?: string;
  /** Click the target once it is found — a tab whose panel the step is about. */
  readonly activate?: boolean;
}

export interface TourContext {
  readonly workspaceId: string;
  /** The assistant whose tabs the middle of the tour walks. Absent when there are none. */
  readonly agent?: { readonly id: string; readonly name: string };
  /** Whether this person runs the workspace: their workspace button opens the admin dashboard rather than Settings. */
  readonly admin?: boolean;
}

/**
 * The script.
 *
 * It starts with the list, walks one assistant's tabs in the order somebody
 * new needs them (talk first, then teach, then automate), and ends on the
 * workspace-wide sections. With no assistant yet the middle collapses to the
 * one thing there is to do.
 */
export function stepsFor(context: TourContext): readonly TourStep[] {
  const agent = context.agent;
  const agentPath = agent === undefined ? undefined : `/agents/${agent.id}`;
  const name = agent?.name ?? 'your assistant';

  const middle: readonly TourStep[] = agentPath === undefined
    ? [{
      id: 'create',
      path: '/agents',
      target: 'create-assistant',
      title: 'Create your first assistant',
      body: 'Name it, connect the Telegram bot it answers on, and pick the model it thinks with. Everything the workspace knows is its from the start.',
    }]
    : [
      {
        id: 'chat',
        path: agentPath,
        target: 'tab-chat',
        activate: true,
        title: 'Chat',
        body: `Talk to ${name} here exactly as you would on Telegram. Chats can be renamed or deleted from the row above the messages.`,
      },
      {
        id: 'documents',
        path: agentPath,
        target: 'tab-documents',
        activate: true,
        title: 'Documents',
        body: 'Upload what it should know: price lists, policies, a company profile. It answers from these and introduces the business by name.',
      },
      {
        id: 'routine',
        path: agentPath,
        target: 'tab-routine',
        activate: true,
        title: 'Routine',
        body: 'Work it should do on its own, on a schedule. A morning summary of new mail, a weekly report, a reminder.',
      },
      {
        id: 'integrations',
        path: agentPath,
        target: 'tab-integrations',
        activate: true,
        title: 'Integrations',
        body: 'Connect Telegram, Google Workspace and other tools here. Anything that changes something waits for your approval first.',
      },
      {
        id: 'model',
        path: agentPath,
        target: 'tab-model',
        activate: true,
        title: 'Model',
        body: `Choose which connected provider and model ${name} thinks with. Each assistant can use a different one.`,
      },
      {
        id: 'server',
        path: agentPath,
        target: 'tab-server',
        activate: true,
        title: 'Server',
        body: `Use ${name} from Claude.ai or ChatGPT too. It has its own address, and you sign in to it with your HIVE account.`,
      },
    ];

  return [
    {
      id: 'welcome',
      title: 'Welcome to HIVE',
      body: 'Assistants that answer on Telegram, learn from your documents and act in your tools, with your approval before anything consequential. This takes about a minute.',
    },
    {
      id: 'assistants',
      path: agentPath ?? '/agents',
      target: 'assistants',
      title: 'Your assistants',
      body: 'Each assistant has its own chats, documents, routines and integrations. Pick one on the left; the plus makes another.',
    },
    ...middle,
    {
      id: 'models',
      target: 'nav-models',
      title: 'Models',
      body: 'Connect your own OpenAI or Claude API key. Keys are encrypted and stored in your own database. Voice notes on Telegram need an OpenAI key.',
    },
    {
      id: 'approvals',
      target: 'nav-approvals',
      title: 'Approvals',
      body: 'Before an assistant sends, deletes or pays for something, it asks you here. A dot on this tab means something is waiting.',
    },
    {
      id: 'activity',
      target: 'nav-activity',
      title: 'Activity',
      body: 'Every run an assistant made: what it did, what it used, what it cost.',
    },
    {
      id: 'workspace',
      target: 'workspace',
      title: 'Your workspace',
      body: context.admin === true
        ? 'Your workspace name, top right, opens the admin dashboard: spend against the daily cap, the week’s runs, who is in the workspace and the limits. Invite people from there.'
        : 'Your workspace name, top right, opens Settings: your account, the look of the app, and signing out.',
    },
    {
      id: 'done',
      target: 'help',
      title: 'That is the tour',
      body: 'Press this any time to see it again. Start by chatting with your assistant, then give it something to read.',
    },
  ];
}

export interface Rect { readonly top: number; readonly left: number; readonly width: number; readonly height: number }
export interface Size { readonly width: number; readonly height: number }

export type Placement =
  /** No target: the card sits in the middle of the screen. */
  | { readonly mode: 'centre' }
  /** A narrow screen: the card is a sheet along the bottom, whatever it points at. */
  | { readonly mode: 'sheet' }
  | { readonly mode: 'anchored'; readonly top: number; readonly left: number; readonly side: 'below' | 'above' | 'right' };

const GAP = 12;
const MARGIN = 16;
/** Below this width a floating card has nowhere to go that is not over the thing it explains. */
export const SHEET_BELOW = 640;

/** The target, inflated so the ring does not touch what it circles. */
export function spotlightOf(target: Rect, pad = 6): Rect {
  return {
    top: target.top - pad,
    left: target.left - pad,
    width: target.width + pad * 2,
    height: target.height + pad * 2,
  };
}

/**
 * Where the card goes.
 *
 * Below the target when it fits, above when it does not, and beside it when
 * the target is as tall as the screen (the assistants list). Never off the
 * edge: a card clamped into view beats one whose buttons are somewhere to
 * the right of the window.
 */
export function placeCard(target: Rect | undefined, card: Size, viewport: Size): Placement {
  if (viewport.width < SHEET_BELOW) return { mode: 'sheet' };
  if (target === undefined) return { mode: 'centre' };

  const spot = spotlightOf(target);
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
  const clampTop = (top: number) => clamp(top, MARGIN, viewport.height - MARGIN - card.height);
  const clampLeft = (left: number) => clamp(left, MARGIN, viewport.width - MARGIN - card.width);
  const centredLeft = spot.left + spot.width / 2 - card.width / 2;

  const fitsBelow = spot.top + spot.height + GAP + card.height <= viewport.height - MARGIN;
  if (fitsBelow) {
    return { mode: 'anchored', side: 'below', top: clampTop(spot.top + spot.height + GAP), left: clampLeft(centredLeft) };
  }
  const fitsAbove = spot.top - GAP - card.height >= MARGIN;
  if (fitsAbove) {
    return { mode: 'anchored', side: 'above', top: clampTop(spot.top - GAP - card.height), left: clampLeft(centredLeft) };
  }
  const fitsRight = spot.left + spot.width + GAP + card.width <= viewport.width - MARGIN;
  if (fitsRight) {
    return {
      mode: 'anchored',
      side: 'right',
      top: clampTop(spot.top + spot.height / 2 - card.height / 2),
      left: clampLeft(spot.left + spot.width + GAP),
    };
  }
  return { mode: 'anchored', side: 'below', top: clampTop(spot.top + spot.height + GAP), left: clampLeft(centredLeft) };
}

/** The `localStorage` key that remembers the tour was seen, for when the network is slow to say so. */
export const SEEN_KEY = 'hive.walkthrough.seen';
