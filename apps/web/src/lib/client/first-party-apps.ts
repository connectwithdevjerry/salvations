/**
 * The built-in apps, as the rules editor names them.
 *
 * The ids are the first-party binding ids the engine reports on a decision
 * and the approval card sends back; the server's `first-party` module is the
 * authority, and a test keeps the two lists identical.
 */
export const FIRST_PARTY_APPS: readonly { id: string; alias: string; label: string }[] = [
  { id: 'mcb_first_party_memory', alias: 'memory', label: 'Memory' },
  { id: 'mcb_first_party_conversation', alias: 'chat', label: 'Chat history' },
  { id: 'mcb_first_party_knowledge', alias: 'knowledge', label: 'Knowledge' },
  { id: 'mcb_first_party_web', alias: 'web', label: 'Web' },
  { id: 'mcb_first_party_studio', alias: 'studio', label: 'Studio' },
];
