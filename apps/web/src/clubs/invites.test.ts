import { describe, expect, it } from 'vitest';
import { clubJoinLink, decodeClubInvite, encodeClubInvite, extractClubToken } from './invites';

const invite = {
  clubId: 'club-1',
  clubName: 'The Back Room',
  address: 'club-1',
  role: 'member' as const,
  autoApprove: true,
  nonce: 'n1',
};

describe('club invites', () => {
  it('round-trips a token and reads it from a link', () => {
    const token = encodeClubInvite(invite, 'sig');
    expect(token.startsWith('p2pc1.')).toBe(true);
    const decoded = decodeClubInvite(token);
    expect(decoded.invite).toEqual(invite);
    expect(decoded.signature).toBe('sig');
    expect(extractClubToken(clubJoinLink(token))).toBe(token);
    expect(decodeClubInvite(`https://x.test/p2p/#/club/join/${token}`).invite.clubId).toBe(
      'club-1',
    );
  });

  it('accepts a bare invite without a signature and defaults the address to the club id', () => {
    const token = encodeClubInvite({ ...invite, address: '' });
    const decoded = decodeClubInvite(token);
    expect(decoded.invite.address).toBe('club-1');
    expect(decoded.signature).toBeUndefined();
  });

  it('rejects garbage', () => {
    expect(extractClubToken('hello')).toBeNull();
    expect(() => decodeClubInvite('p2pc1.@@@')).toThrow(/damaged/);
    expect(() => decodeClubInvite(encodeClubInvite({ ...invite, clubId: '' } as never))).toThrow(
      /missing the club/,
    );
  });
});
