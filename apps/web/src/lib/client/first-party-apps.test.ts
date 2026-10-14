import { describe, expect, it } from 'vitest';
import { firstPartyBindings } from '../first-party';
import { FIRST_PARTY_APPS } from './first-party-apps';

describe('the editor names every built-in app by its real id', () => {
  it('matches the server\'s own list exactly', () => {
    const server = firstPartyBindings('wks_1').map((b) => ({ id: b.binding.id, alias: b.binding.alias }));
    expect(FIRST_PARTY_APPS.map((a) => ({ id: a.id, alias: a.alias }))).toEqual(server);
  });
});
