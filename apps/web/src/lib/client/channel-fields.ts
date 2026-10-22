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
