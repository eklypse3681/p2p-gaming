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

describe('an invite a club actually issued', () => {
  it('reads the signed three-part token, as a link or bare', async () => {
    const { generateKeyPair, signerFor } = await import('@bgf/protocol');
    const { signInvite } = await import('@bgf/club');
    const keys = await generateKeyPair();
    const token = await signInvite(
      {
        clubId: 'club-id',
        clubName: 'The House',
        address: 'club-id',
        role: 'member',
        autoApprove: true,
        nonce: 'n1',
      },
      signerFor(keys.privateKey),
    );
    expect(token.split('.')).toHaveLength(3);
    for (const input of [token, clubJoinLink(token)]) {
      const decoded = decodeClubInvite(input);
      expect(decoded.token).toBe(token);
      expect(decoded.invite).toMatchObject({ clubId: 'club-id', clubName: 'The House' });
      expect(decoded.signature).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    expect(() => decodeClubInvite(`${token.slice(0, -4)}.x.y`)).toThrow(/damaged/);
  });
});
