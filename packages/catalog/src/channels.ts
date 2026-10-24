/**
 * Chat platforms an agent talks through.
 *
 * A channel is not an integration: it is how a person reaches the agent, not
 * something the agent reaches. That distinction is why they are two lists in
 * the UI — connecting Telegram changes where you can talk to your agent, and
 * connecting Gmail changes what it can do.
 *
 * Every one of these is a bot you create and own. We never ask for a personal
 * account password, and the token you paste is yours to revoke. iMessage is
 * the exception that proves it: Apple has no bot API, so the "bot" is a Mac
 * of your own, and the password is the one you set on it.
 *
 * What each one can do is limited by what the platform offers a server that does
 * not hold a socket open. Telegram and Slack push to a URL, so those are real
 * conversations. Discord only pushes interactions, so it is a slash command —
 * stated here rather than discovered by someone whose DM went unanswered. On
 * all three the assistant asks with buttons, shows pictures and clips, and
 * rewrites its reply as it writes.
 */
import type { CatalogEntry } from './types';

const TELEGRAM: CatalogEntry = {
  id: 'telegram',
  kind: 'channel',
  category: 'Chat',
  name: 'Telegram',
  summary: 'DM your agent on Telegram through a bot you create with BotFather.',
  setup: 'bot_token',
  accent: '#2AABEE',
  docs: 'https://core.telegram.org/bots#how-do-i-create-a-bot',
  steps: [
    {
      title: 'Open BotFather',
      body: 'BotFather is Telegram\'s own bot for making bots. Open it in the app you ' +
        'already use. It is the account with the blue verified tick.',
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
        'never shown again. If you lose it, /token gets you a new one.',
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
  category: 'Chat',
  name: 'Discord',
  summary: 'Add it to your server with one press, then ask it from any channel with the /hive command. It answers with buttons, pictures and clips.',
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
        '"Send Messages" and "Embed Links". Open the URL it builds and pick a server. ' +
        'The /hive command is created for you the moment you connect.',
    },
  ],
  scopes: [
    { label: 'Receive the /hive command wherever it is invited', scope: 'applications.commands', writes: false },
    { label: 'Send messages, buttons, pictures and clips in those channels', scope: 'bot:send_messages', writes: true },
  ],
};

const SLACK: CatalogEntry = {
  id: 'slack',
  kind: 'channel',
  category: 'Chat',
  name: 'Slack',
  summary: 'Add it to your Slack workspace with one press, then DM it or mention it in a channel. Approve with a button, send a voice clip, get the picture back.',
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
      body: 'Under OAuth & Permissions → Bot Token Scopes, add chat:write, im:history, ' +
        'app_mentions:read, files:read and files:write. The first three are the ' +
        'conversation; the last two are voice clips in and pictures and clips out.',
    },
    {
      title: 'Let people message it',
      body: 'Under App Home → Show Tabs, turn the Messages Tab on and tick "Allow users to ' +
        'send Slash commands and messages from the messages tab". Without this, a DM to ' +
        'the app shows "Sending messages to this app has been turned off".',
    },
    {
      title: 'Install it and copy the bot token',
      body: 'Under Install App in the left menu, press Install to Workspace and allow it. ' +
        'The Bot User OAuth Token then appears on that same page, and on OAuth & ' +
        'Permissions under OAuth Tokens. It starts with "xoxb-". The user token ' +
        'starting "xoxp-" is not the one.',
    },
    {
      title: 'Copy the signing secret from a different page',
      body: 'It is not with the token. Go to Basic Information → App Credentials and ' +
        'copy Signing Secret. Slack signs deliveries with this one and authorises ' +
        'calls with the other, so both are needed.',
    },
    {
      title: 'Point its events at us',
      body: 'Under Event Subscriptions, enable events and paste the request URL we show ' +
        'you after connecting, then subscribe to message.im and app_mention. Slack ' +
        'checks the URL by challenging it, so it saves only if the connection works.',
    },
    {
      title: 'Turn on buttons',
      body: 'Under Interactivity & Shortcuts, switch interactivity on and paste the same ' +
        'request URL. That is how a press on Approve reaches your assistant.',
    },
  ],
  scopes: [
    { label: 'Read direct messages, mentions and voice clips', scope: 'im:history, app_mentions:read, files:read', writes: false },
    { label: 'Post messages, buttons, pictures and clips as the bot', scope: 'chat:write, files:write', writes: true },
  ],
};

const WHATSAPP: CatalogEntry = {
  id: 'whatsapp',
  kind: 'channel',
  category: 'Chat',
  name: 'WhatsApp',
  summary: 'Message your agent on WhatsApp from your own Meta app and business number. Buttons, pictures, clips and voice notes, straight from Meta\'s API.',
  setup: 'bot_token',
  accent: '#25D366',
  docs: 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started',
  steps: [
    {
      title: 'Create a Meta app with WhatsApp on it',
      body: 'In the Meta developer portal, create an app of the Business type and add the ' +
        'WhatsApp product. Meta gives it a test number straight away; your own number can ' +
        'be added later, under the same product.',
      link: { label: 'Open the Meta developer portal', url: 'https://developers.facebook.com/apps/' },
    },
    {
      title: 'Copy the phone number ID',
      body: 'Under WhatsApp → API Setup, beside the number the assistant will answer from. ' +
        'It is a long number, not the phone number itself. With the test number, add your ' +
        'own phone to its recipient list on the same page.',
    },
    {
      title: 'Make a permanent access token',
      body: 'A temporary token from API Setup works for a day. For one that lasts, go to ' +
        'Business settings → System users, add a system user, give it the app with ' +
        'whatsapp_business_messaging and whatsapp_business_management, and generate a token.',
      link: { label: 'Open Business settings', url: 'https://business.facebook.com/settings/system-users' },
    },
    {
      title: 'Copy the app secret',
      body: 'Under App settings → Basic. Meta signs every delivery with it, so a delivery ' +
        'that cannot be checked against it is never acted on.',
    },
    {
      title: 'Point its webhook at us',
      body: 'Under WhatsApp → Configuration, paste the callback URL and the verify token we ' +
        'show you after connecting, then subscribe to the messages field. Meta checks the ' +
        'URL before it saves it, so a green tick means the connection works.',
    },
    {
      title: 'Say hello',
      body: 'From your phone, send the business number the code we show you. That first ' +
        'message is what proves the chat is yours.',
    },
  ],
  scopes: [
    { label: 'Receive messages, voice notes and button taps sent to your number', scope: 'whatsapp_business_messaging', writes: false },
    { label: 'Reply with text, buttons, pictures and clips', scope: 'whatsapp_business_messaging', writes: true },
  ],
};

const IMESSAGE: CatalogEntry = {
  id: 'imessage',
  kind: 'channel',
  category: 'Chat',
  name: 'iMessage',
  summary: 'Text your agent from Messages, through a Mac of your own that stays on. Apple offers no other way, and nothing of yours leaves that Mac.',
  setup: 'bot_token',
  accent: '#34C759',
  docs: 'https://docs.bluebubbles.app/server',
  steps: [
    {
      title: 'Install the BlueBubbles server on a Mac',
      body: 'A Mac that stays on and signed in to Messages, with its own Apple ID for the ' +
        'assistant if you would rather keep yours. BlueBubbles is open source; it runs ' +
        'only on that Mac and holds your messages nowhere else.',
      link: { label: 'Get the server', url: 'https://bluebubbles.app/downloads/server/' },
    },
    {
      title: 'Set a password and give it an address',
      body: 'On its Connection page, set the server password and pick a proxy. Cloudflare ' +
        'needs no account and gives you an https address; copy that address.',
    },
    {
      title: 'Paste the address and the password below',
      body: 'We ask the Mac who it is signed in as before anything is saved, and tell it where ' +
        'to send new messages. There is nothing to paste back into the Mac.',
    },
    {
      title: 'Say hello',
      body: 'From your iPhone, text the Mac\'s Apple ID the code we show you. That first ' +
        'message is what proves the chat is yours.',
    },
  ],
  scopes: [
    { label: 'Read messages and voice memos sent to the Mac', scope: 'bluebubbles:read', writes: false },
    { label: 'Reply from the Mac, with pictures and clips as attachments', scope: 'bluebubbles:send', writes: true },
  ],
};

export const CHANNELS: readonly CatalogEntry[] = [TELEGRAM, WHATSAPP, IMESSAGE, SLACK, DISCORD];
