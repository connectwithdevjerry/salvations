/**
 * Chat platforms an agent talks through.
 *
 * A channel is not an integration: it is how a person reaches the agent, not
 * something the agent reaches. That distinction is why they are two lists in
 * the UI — connecting Telegram changes where you can talk to your agent, and
 * connecting Gmail changes what it can do.
 *
 * Every one of these is a bot you create and own. We never ask for a personal
 * account password, and the token you paste is yours to revoke.
 *
 * What each one can do is limited by what the platform offers a server that does
 * not hold a socket open. Telegram and Slack push to a URL, so those are real
 * conversations. Discord only pushes interactions, so it is a slash command —
 * stated here rather than discovered by someone whose DM went unanswered.
 */
import type { CatalogEntry } from './types';

const TELEGRAM: CatalogEntry = {
  id: 'telegram',
  kind: 'channel',
  name: 'Telegram',
  summary: 'DM your agent on Telegram through a bot you create with BotFather.',
  setup: 'bot_token',
  accent: '#2AABEE',
  docs: 'https://core.telegram.org/bots#how-do-i-create-a-bot',
  steps: [
    {
      title: 'Open BotFather',
      body: 'BotFather is Telegram\'s own bot for making bots. Open it in the app you ' +
        'already use — it is the account with the blue verified tick.',
      link: { label: 'Open @BotFather', url: 'https://t.me/BotFather' },
    },
    {
      title: 'Create the bot',
      body: 'Send this, then answer its two questions: a display name, and a username ' +
        'that has to end in "bot".',
      literal: '/newbot',
    },
    {
      title: 'Paste the token it gives you',
      body: 'BotFather replies with a line beginning "Use this token to access the HTTP ' +
        'API". Paste that token below. It goes straight into encrypted storage and is ' +
        'never shown again — if you lose it, /token gets you a new one.',
    },
    {
      title: 'Say hello',
      body: 'Open your new bot and send it the code we show you. That first message is ' +
        'what proves the chat is yours: the agent answers you and nobody else.',
    },
  ],
  scopes: [
    { label: 'Read messages sent directly to your bot', scope: 'bot:messages.read', writes: false },
    { label: 'Reply in those chats', scope: 'bot:messages.write', writes: true },
  ],
};

const DISCORD: CatalogEntry = {
  id: 'discord',
  kind: 'channel',
  name: 'Discord',
  summary: 'Ask your agent from any Discord channel with a /hive command.',
  setup: 'bot_token',
  accent: '#5865F2',
  docs: 'https://discord.com/developers/docs/interactions/overview',
  steps: [
    {
      title: 'Create an application',
      body: 'In the Discord developer portal, press New Application and give it a name. ' +
        'This is the identity people will see your agent under.',
      link: { label: 'Open the developer portal', url: 'https://discord.com/developers/applications' },
    },
    {
      title: 'Add a bot and copy its token',
      body: 'Under Bot, press Reset Token and copy what it shows. Discord displays a bot ' +
        'token exactly once.',
    },
    {
      title: 'Copy the application public key',
      body: 'On General Information. Discord signs every delivery with it, and an ' +
        'endpoint that cannot check the signature is one Discord turns off.',
    },
    {
      title: 'Point its interactions endpoint at us',
      body: 'Back on General Information, paste the interactions endpoint URL we show ' +
        'you after connecting. Discord will not save it until it has pinged it and been ' +
        'answered, so a green tick there means the connection works.',
    },
    {
      title: 'Invite it where you want it',
      body: 'Under OAuth2 → URL Generator, tick "bot" and "applications.commands", then ' +
        '"Send Messages". Open the URL it builds and pick a server.',
    },
  ],
  scopes: [
    { label: 'Receive the /hive command wherever it is invited', scope: 'applications.commands', writes: false },
    { label: 'Send messages in those channels', scope: 'bot:send_messages', writes: true },
  ],
};

const SLACK: CatalogEntry = {
  id: 'slack',
  kind: 'channel',
  name: 'Slack',
  summary: 'Connect a Slack workspace for direct messages and channel mentions.',
  setup: 'bot_token',
  accent: '#611F69',
  docs: 'https://api.slack.com/quickstart',
  steps: [
    {
      title: 'Create a Slack app',
      body: 'Choose "From scratch" and pick the workspace you want your agent in.',
      link: { label: 'Open Slack app management', url: 'https://api.slack.com/apps' },
    },
    {
      title: 'Give it the scopes it needs',
      body: 'Under OAuth & Permissions → Bot Token Scopes, add chat:write, im:history ' +
        'and app_mentions:read. Fewer than these and it cannot hold a conversation.',
    },
    {
      title: 'Install it and copy the bot token',
      body: 'Press Install to Workspace. The Bot User OAuth Token starts with "xoxb-". ' +
        'That is the one — the user token starting "xoxp-" is not.',
    },
    {
      title: 'Copy the signing secret too',
      body: 'Under Basic Information → App Credentials. It is not the bot token: Slack ' +
        'signs deliveries with this one and authorises calls with the other.',
    },
    {
      title: 'Point its events at us',
      body: 'Under Event Subscriptions, enable events and paste the request URL we show ' +
        'you after connecting, then subscribe to message.im and app_mention. Slack ' +
        'checks the URL by challenging it, so it saves only if the connection works.',
    },
  ],
  scopes: [
    { label: 'Read direct messages and mentions', scope: 'im:history, app_mentions:read', writes: false },
    { label: 'Post messages as the bot', scope: 'chat:write', writes: true },
  ],
};

export const CHANNELS: readonly CatalogEntry[] = [TELEGRAM, DISCORD, SLACK];
