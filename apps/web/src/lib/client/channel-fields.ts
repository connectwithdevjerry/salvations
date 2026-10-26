/**
 * What the connect form asks for, per platform, on the browser side.
 *
 * The adapters know this too, and are the truth; they cannot be imported
 * into a client component, so the form carries a copy and a test keeps the
 * two from drifting.
 */
export interface FieldCopy { readonly label: string; readonly help: string; readonly placeholder?: string }

/** The platform's own signing secret, when it issues one. */
export const SECONDARY: Readonly<Record<string, FieldCopy>> = {
  slack: {
    label: 'Signing secret',
    help: 'Under Basic Information → App Credentials. Not the bot token.',
  },
  discord: {
    label: 'Application public key',
    help: 'On the application\'s General Information page.',
  },
  whatsapp: {
    label: 'App secret',
    help: 'Under App settings → Basic in your Meta app. Meta signs every delivery with it.',
  },
};

/** A non-secret the platform needs beside the token. */
export const EXTRA: Readonly<Record<string, FieldCopy>> = {
  whatsapp: {
    label: 'Phone number ID',
    help: 'Under WhatsApp → API Setup, beside the number the assistant answers from. A long number, not the phone number itself.',
    placeholder: '106540352242922',
  },
  imessage: {
    label: 'Server address',
    help: 'The public address of the BlueBubbles server on your Mac, from its Connection page.',
    placeholder: 'https://quiet-river-1234.trycloudflare.com',
  },
};

/** What to call the token when "bot token" is the wrong name. */
export const TOKEN_LABEL: Readonly<Record<string, string>> = {
  whatsapp: 'Access token',
  imessage: 'Server password',
};

export const tokenLabelOf = (channelId: string): string => TOKEN_LABEL[channelId] ?? 'Bot token';

/**
 * The address a platform needs pasted into its own dashboard once the
 * connection exists, and what that platform calls it. Absent where the
 * platform is told over the API (Telegram, iMessage).
 */
export const ADDRESS_LABEL: Readonly<Record<string, string>> = {
  slack: 'Request URL',
  discord: 'Interactions endpoint URL',
  whatsapp: 'Callback URL',
};

/** The note under that address. */
export const ADDRESS_NOTE: Readonly<Record<string, string>> = {
  slack: 'Paste it twice in Slack: under Event Subscriptions, and under Interactivity & Shortcuts so buttons work.',
  discord: 'Paste it on the application’s General Information page. The /hive command is already created.',
  whatsapp: 'Under WhatsApp → Configuration in your Meta app, with the verify token below. Then subscribe to the messages field.',
};

/**
 * What tends to go wrong in the platform's own app after the connection
 * exists, and the fix for each. Shown beside the address once connected,
 * because this is the moment people find out.
 */
export const AFTER_CONNECT: Readonly<Record<string, readonly string[]>> = {
  slack: [
    'A DM to the app says "Sending messages to this app has been turned off": in the Slack app settings go to App Home → Show Tabs, turn the Messages Tab on and tick "Allow users to send Slash commands and messages from the messages tab".',
    'The app does not answer in a channel until it is invited: type /invite @ followed by its name in that channel, then mention it.',
    'Changed the scopes after installing? Slack asks you to reinstall the app. Do that, then paste the bot token again here if it changed.',
    'Slack rejected the request URL? It only saves once this connection exists, so paste the address after connecting, not before.',
  ],
  whatsapp: [
    'Meta\'s test number only talks to phone numbers added as recipients under WhatsApp → API Setup. Your own number can be added there.',
    'The assistant can message someone only within 24 hours of their last message. Outside that window a reply needs an approved template.',
  ],
  discord: [
    'The /hive command can take a minute to show up in a server. If it is still missing, reopen Discord so it refreshes the command list.',
  ],
};

/** The one-press connection, where this deployment has an app of its own. */
export const ONE_CLICK: Readonly<Record<string, { title: string; lede: string; button: string; manual: string }>> = {
  slack: {
    title: 'Add it to your Slack in one press',
    lede: 'Slack asks you to allow it, and you are back here connected. Everyone in that workspace can then message it, and each person gets their own thread.',
    button: 'Add to Slack',
    manual: 'Prefer your own Slack app? Do it the long way',
  },
  discord: {
    title: 'Add it to your Discord server in one press',
    lede: 'Discord asks which server and whether to allow it, and you are back here connected. Anyone in that server can then use /hive, and each person gets their own thread.',
    button: 'Add to Discord',
    manual: 'Prefer your own Discord application? Do it the long way',
  },
  whatsapp: {
    title: 'Connect your WhatsApp number in one press',
    lede: 'Meta opens a window where you pick or create your WhatsApp Business account and number, and you are back here connected. Anyone who messages that number then reaches the assistant.',
    button: 'Connect WhatsApp',
    manual: 'Prefer your own Meta app? Do it the long way',
  },
  telegram: {
    title: 'Connect Telegram in one press',
    lede: 'Press, then say hello to HIVE\'s bot from your phone: a link opens the chat with your code already typed. That first message is what makes the chat yours.',
    button: 'Connect Telegram',
    manual: 'Prefer a bot of your own, under your own name? Do it the long way',
  },
};

/** What to say beside a connection made through this deployment\'s own app. */
export const INSTALLED_NOTE: Readonly<Record<string, string>> = {
  slack: 'Connected through HIVE\'s own Slack app. Nothing to paste into Slack: messages already reach it.',
  discord: 'Connected through HIVE\'s own Discord application. Nothing to paste into Discord: /hive already reaches it.',
  whatsapp: 'Connected through HIVE\'s own Meta app. Nothing to paste into Meta: messages to that number already reach it.',
  telegram: 'Connected through HIVE\'s own Telegram bot. This chat is bound to it; nothing to paste into Telegram.',
};

/** The snags that remain once the app did the setup. */
export const AFTER_INSTALL: Readonly<Record<string, readonly string[]>> = {
  slack: [
    'The app does not answer in a channel until it is invited: type /invite @ followed by its name in that channel, then mention it.',
    'Disconnecting here revokes its token, so Slack stops reaching it at once. To remove the app from Slack entirely as well, do that under Slack\'s app settings.',
  ],
  discord: [
    'The /hive command can take a minute to show up in the server. If it is still missing, reopen Discord so it refreshes the command list.',
    'Direct messages to the bot are not connected with the shared application: use /hive in a channel of the server you added it to.',
    'Disconnecting here stops the assistant answering. To remove the bot from the server as well, kick it under Server Settings → Integrations.',
  ],
  whatsapp: [
    'Before the number can send, Meta needs a payment method on the WhatsApp Business account: Meta Business Suite → Billing. Receiving works without it.',
    'The assistant can message someone only within 24 hours of their last message. Outside that window a reply needs an approved template.',
    'A number already in use on the WhatsApp app has to be moved to the Cloud API first, which Meta\'s window walks through.',
  ],
  telegram: [
    'The bot is shared by every workspace on this deployment, so it carries HIVE\'s name rather than yours. A bot under your own name is the long way.',
    'Only this chat is connected. To connect another phone or person, disconnect here and press Connect Telegram again from their account.',
  ],
};

/** Said above the long form when this platform could be one press but the deployment has no app of its own yet. */
export const ONE_CLICK_UNSET: Readonly<Record<string, string>> = {
  slack: 'Slack can be one press, "Add to Slack", once whoever runs this deployment adds its Slack app keys on the admin dashboard. Until then, the steps below.',
  // Discord is connected the manual way by decision; no hint promises a press.
  whatsapp: 'WhatsApp can be one press once whoever runs this deployment adds its Meta app and WhatsApp sign-up configuration on the admin dashboard. Until then, the steps below.',
  telegram: 'Telegram can be one press, with a bot HIVE provides, once whoever runs this deployment adds its bot token on the admin dashboard. Until then, the steps below make a bot of your own.',
};
