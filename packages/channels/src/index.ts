/**
 * Chat platforms, one adapter each.
 *
 * The registry is the only place that maps a catalogue id to code. Everything
 * else — the routes, the UI, the delivery path — asks for an adapter by id and
 * gets the port back, which is what keeps three very different platforms from
 * turning into three branches in every caller.
 */
export * from './port';
export { telegramAdapter, chunk, SECRET_HEADER } from './telegram';
export { discordAdapter, split } from './discord';
export { slackAdapter, MAX_SKEW_SECONDS } from './slack';

import type { ChannelAdapter } from './port';
import { telegramAdapter } from './telegram';
import { discordAdapter } from './discord';
import { slackAdapter } from './slack';

const ADAPTERS: readonly ChannelAdapter[] = [telegramAdapter, discordAdapter, slackAdapter];

const BY_ID: ReadonlyMap<string, ChannelAdapter> = new Map(
  ADAPTERS.map((adapter) => [adapter.channelId, adapter]),
);

export const channelAdapter = (channelId: string): ChannelAdapter | undefined =>
  BY_ID.get(channelId);

export const CHANNEL_IDS: readonly string[] = ADAPTERS.map((a) => a.channelId);
