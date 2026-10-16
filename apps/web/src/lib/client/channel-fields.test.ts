import { describe, expect, it } from 'vitest';
import { CHANNEL_IDS, channelAdapter } from '@salvations/channels';
import { EXTRA, SECONDARY, TOKEN_LABEL } from './channel-fields';

describe('the connect form agrees with the adapters', () => {
  it('asks for a signing secret exactly where an adapter declares one', () => {
    for (const id of CHANNEL_IDS) {
      const adapter = channelAdapter(id);
      expect(SECONDARY[id]?.label, id).toBe(adapter?.secondarySecret?.label);
    }
  });

  it('asks for the extra value exactly where an adapter declares one', () => {
    for (const id of CHANNEL_IDS) {
      const adapter = channelAdapter(id);
      expect(EXTRA[id]?.label, id).toBe(adapter?.extraField?.label);
      expect(TOKEN_LABEL[id], id).toBe(adapter?.tokenLabel);
    }
  });
});
