import { describe, expect, it } from 'vitest';
import { extractCode, extractGame, identityFromSearch, joinLink } from './links';
import { decodeTransferCode, encodeIdentityCode } from './transfer';

const alice = { id: 'alice-id', name: 'Alice', avatar: '🦊' };

describe('links', () => {
  it('builds a join link without any profile', () => {
    expect(joinLink('ABC234')).toMatch(/#\/backgammon\/join\/ABC234$/);
    expect(extractCode(joinLink('ABC234'))).toBe('ABC234');
    expect(extractGame(joinLink('ABC234'))).toBe('backgammon');
  });

  it('still reads the identity an old hand-off link carried as ?import=', () => {
    const link = `${joinLink('ABC234')}?import=${encodeIdentityCode(alice)}`;
    expect(extractCode(link)).toBe('ABC234');
    const search = link.slice(link.indexOf('?import='));
    const code = identityFromSearch(search);
    expect(code).not.toBeNull();
    expect(decodeTransferCode(code!).profile).toMatchObject(alice);
    expect(identityFromSearch('')).toBeNull();
    expect(identityFromSearch('?other=1')).toBeNull();
  });
});
