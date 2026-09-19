import { describe, expect, it } from 'vitest';
import { validateClientMessage, validatePlay, validateProfile } from '../src/index.js';

describe('validateClientMessage', () => {
  it('accepts well-formed messages and normalises text', () => {
    expect(validateClientMessage({ type: 'roll' })).toEqual({
      ok: true,
      message: { type: 'roll' },
    });
    expect(validateClientMessage({ type: 'chat', text: '  hi  ' })).toEqual({
      ok: true,
      message: { type: 'chat', text: 'hi' },
    });
    expect(validateClientMessage({ type: 'offer-resign', stakes: 'gammon' })).toEqual({
      ok: true,
      message: { type: 'offer-resign', stakes: 'gammon' },
    });
    expect(validateClientMessage({ type: 'ping', t: 5 })).toEqual({
      ok: true,
      message: { type: 'ping', t: 5 },
    });
    const play = [{ from: 8, to: 5, die: 3, hit: 'yes' }];
    expect(validateClientMessage({ type: 'play', play })).toEqual({
      ok: true,
      message: { type: 'play', play: [{ from: 8, to: 5, die: 3, hit: false }] },
    });
    const hello = validateClientMessage({
      type: 'hello',
      protocol: 1,
      profile: { id: 'x', name: '  Zed  ', avatar: '🎲', extra: 1 },
    });
    expect(hello).toEqual({
      ok: true,
      message: { type: 'hello', protocol: 1, profile: { id: 'x', name: 'Zed', avatar: '🎲' } },
    });
  });

  it('rejects malformed messages', () => {
    const bad: unknown[] = [
      null,
      'roll',
      { type: 42 },
      { type: 'nope' },
      { type: 'chat', text: '   ' },
      { type: 'chat', text: 7 },
      { type: 'offer-resign', stakes: 'double' },
      { type: 'ping', t: 'now' },
      { type: 'play', play: [{ from: 26, to: 1, die: 1 }] },
      { type: 'play', play: [{ from: 8, to: 5, die: 7 }] },
      { type: 'play', play: new Array(5).fill({ from: 8, to: 5, die: 3 }) },
      { type: 'preview', play: 'x' },
      { type: 'hello', protocol: 1, profile: { id: '', name: 'x' } },
      { type: 'hello', protocol: 1, profile: { id: 'a', name: '   ' } },
      { type: 'hello', profile: { id: 'a', name: 'b' } },
      { type: 'hello', protocol: 1, profile: { id: 'a', name: 'b' }, snapshot: { id: 5 } },
    ];
    for (const m of bad) expect(validateClientMessage(m).ok, JSON.stringify(m)).toBe(false);
  });

  it('caps chat and name length', () => {
    const r = validateClientMessage({ type: 'chat', text: 'x'.repeat(2000) });
    expect(
      r.ok && r.message.type === 'chat'
        ? (r.message as unknown as { text: string }).text.length
        : 0,
    ).toBe(500);
    expect(validateProfile({ id: 'a', name: 'n'.repeat(100) })!.name.length).toBe(40);
    expect(validatePlay([])).toEqual([]);
  });
});
