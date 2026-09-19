import { describe, expect, it } from 'vitest';
import type { AutopilotContext } from '@bgf/table';
import type { TableConfig, TableState } from '../src/index.js';
import {
  DEFAULT_FLOW,
  defaultConfig,
  fantasylandQualification,
  flowConfig,
  getPreset,
  init,
  ofcAutopilot,
  reduce,
  validateTableConfig,
} from '../src/index.js';
import { rows } from './helpers.js';

function ctx(
  state: TableState,
  over: Partial<AutopilotContext<TableConfig>> = {},
): AutopilotContext<TableConfig> {
  const n = state.config.seats;
  return {
    seatsFilled: new Array<boolean>(n).fill(true),
    present: new Array<boolean>(n).fill(true),
    ready: new Array<boolean>(n).fill(false),
    dealerPresent: true,
    now: 1_000,
    config: state.config,
    ...over,
  };
}

/** A table sitting at a showdown (hand scored, nothing dealt yet). */
function atShowdown(config: Partial<TableConfig> = {}): TableState {
  const s = init({ variant: 'pineapple', seats: 2, ...config });
  return {
    ...s,
    status: 'playing',
    handNumber: 1,
    hand: {
      number: 1,
      button: 0,
      phase: 'showdown',
      seats: [],
      toAct: null,
      deck: [],
      result: null,
    },
  };
}

describe('ofcAutopilot decisions', () => {
  it('lobby: deals the first hand only when every seat is taken, present and the dealer is here', () => {
    const s = init({ variant: 'pineapple', seats: 3 });
    expect(ofcAutopilot(s, ctx(s))).toMatchObject({ command: { type: 'start' } });
    expect(ofcAutopilot(s, ctx(s, { seatsFilled: [true, true, false] }))).toBeNull();
    expect(ofcAutopilot(s, ctx(s, { present: [true, false, true] }))).toBeNull();
    expect(ofcAutopilot(s, ctx(s, { dealerPresent: false }))).toBeNull();
    const eager = init({
      variant: 'pineapple',
      seats: 3,
      flow: { ...DEFAULT_FLOW, pauseWhenAbsent: false },
    });
    expect(ofcAutopilot(eager, ctx(eager, { present: [true, false, true] }))).toMatchObject({
      command: { type: 'start' },
    });
    const manual = init({
      variant: 'pineapple',
      seats: 3,
      flow: { ...DEFAULT_FLOW, startWhenFull: false },
    });
    expect(ofcAutopilot(manual, ctx(manual))).toBeNull();
  });

  it('never acts while a hand is being set or once the table is over', () => {
    const s = init({ variant: 'pineapple', seats: 2 });
    const setting: TableState = {
      ...s,
      status: 'playing',
      hand: { number: 1, button: 0, phase: 'setting', seats: [], toAct: 0, deck: [], result: null },
    };
    expect(ofcAutopilot(setting, ctx(setting, { ready: [true, true] }))).toBeNull();
    const over: TableState = { ...atShowdown(), status: 'over' };
    expect(ofcAutopilot(over, ctx(over, { ready: [true, true] }))).toBeNull();
  });

  it('after a showdown: ready mode waits for everyone, countdown mode schedules', () => {
    const s = atShowdown();
    expect(ofcAutopilot(s, ctx(s))).toBeNull();
    expect(ofcAutopilot(s, ctx(s, { ready: [true, false] }))).toBeNull();
    expect(ofcAutopilot(s, ctx(s, { ready: [true, true] }))).toMatchObject({
      command: { type: 'start' },
      reason: expect.stringMatching(/ready/),
    });
    expect(ofcAutopilot(s, ctx(s, { ready: [true, true], present: [true, false] }))).toBeNull();
    const c = atShowdown({
      flow: { ...DEFAULT_FLOW, nextHand: 'countdown', nextHandDelayMs: 3_000 },
    });
    expect(ofcAutopilot(c, ctx(c))).toEqual({
      command: { type: 'start' },
      afterMs: 3_000,
      reason: 'next hand in 3 s',
    });
    expect(ofcAutopilot(c, ctx(c, { present: [false, true] }))).toBeNull();
  });

  it('settles when every seat asked, before dealing on', () => {
    let s = atShowdown();
    s = reduce(s, { type: 'settle-request', seat: 0, requested: true });
    expect(ofcAutopilot(s, ctx(s, { ready: [true, true] }))).toMatchObject({
      command: { type: 'start' },
    });
    s = reduce(s, { type: 'settle-request', seat: 1, requested: true });
    expect(ofcAutopilot(s, ctx(s, { ready: [true, true] }))).toMatchObject({
      command: { type: 'settle' },
    });
    const settled = reduce(s, { type: 'settle', at: 5 });
    expect(settled.settleRequests).toEqual([false, false]);
    expect(ofcAutopilot(settled, ctx(settled))).toBeNull();
    const noConsensus = {
      ...s,
      config: { ...s.config, flow: { ...DEFAULT_FLOW, settleOnConsensus: false } },
    };
    expect(ofcAutopilot(noConsensus, ctx(noConsensus))).toBeNull();
  });

  it('tolerates tables created before flow and settle requests existed', () => {
    const legacy = init({ variant: 'ofc', seats: 2 }) as TableState & {
      config: Partial<TableConfig>;
    };
    delete (legacy as { settleRequests?: unknown }).settleRequests;
    delete legacy.config.flow;
    expect(flowConfig(legacy.config as TableConfig)).toEqual(DEFAULT_FLOW);
    expect(ofcAutopilot(legacy as TableState, ctx(legacy as TableState))).toMatchObject({
      command: { type: 'start' },
    });
  });

  it('validates flow in a rules JSON', () => {
    const ok = validateTableConfig({ flow: { nextHand: 'countdown', nextHandDelayMs: 12000 } });
    expect(ok.ok && ok.config.flow).toEqual({
      ...DEFAULT_FLOW,
      nextHand: 'countdown',
      nextHandDelayMs: 12000,
    });
    const bad = validateTableConfig({ flow: { nextHand: 'later', nextHandDelayMs: -1 } });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.errors.join(' ')).toMatch(/nextHand/);
  });
});

describe('Pineapple 2-7 house defaults', () => {
  const low = defaultConfig({ variant: 'pineapple27' });

  it('scores the middle 1-2-4-8 and enters on KK or a wheel with super Fantasyland on', () => {
    expect(low.royalties.middleLow).toEqual({ ten: 0, nine: 1, eight: 2, seven: 4, wheel: 8 });
    expect(low.fantasyland.entry).toBe('KK');
    expect(low.fantasyland.superFantasyland).toBe(true);
    expect(low.fantasyland.stay).toEqual({
      topTrips: true,
      middleFullHouse: false,
      bottomQuads: true,
    });
    expect(getPreset('pineapple27')!.config.fantasyland.superFantasyland).toBe(true);
    // The standard presets are untouched.
    const std = defaultConfig({ variant: 'pineapple' });
    expect(std.fantasyland).toMatchObject({ entry: 'QQ', superFantasyland: false });
    expect(std.fantasyland.stay.middleFullHouse).toBe(true);
  });

  it('enters via KK on top, via a middle wheel, and deals 15 for both in one hand', () => {
    const kk = rows('Kd Kc 2s', 'Td 8c 5h 3s 2d', 'Ad Ac Ah 3s 3c');
    expect(fantasylandQualification(kk, false, low)).toEqual({ cards: 14, reasons: ['top KK'] });
    const wheel = rows('Qd 9c 2s', '7d 5c 4h 3s 2d', 'Kd Kc 9h 3s 3c');
    expect(fantasylandQualification(wheel, false, low)).toEqual({
      cards: 14,
      reasons: ['middle wheel'],
    });
    const both = rows('Kd Kc 2s', '7d 5c 4h 3s 2d', 'Ad Ac Ah 3s 3c');
    expect(fantasylandQualification(both, false, low)).toEqual({
      cards: 15,
      reasons: ['top KK', 'middle wheel'],
    });
    expect(
      fantasylandQualification(rows('Qd Qc 2s', 'Td 8c 5h 3s 2d', 'Ad Ac Ah 3s 3c'), false, low)
        .cards,
    ).toBe(0);
  });

  it('stays only on top trips or bottom quads+, never on a middle wheel', () => {
    const wheelInFl = rows('Qd 9c 2s', '7d 5c 4h 3s 2d', 'Kd Kc 9h 3s 3c');
    expect(fantasylandQualification(wheelInFl, true, low).cards).toBe(0);
    expect(
      fantasylandQualification(rows('2d 2c 2s', 'Td 8c 5h 3s 2d', 'Kd Kc 9h 3s 3c'), true, low)
        .reasons,
    ).toEqual(['top trips']);
    expect(
      fantasylandQualification(rows('Qd 9c 2s', 'Td 8c 5h 3s 2d', 'Kd Kc Kh Ks 3c'), true, low)
        .reasons,
    ).toEqual(['bottom quads+']);
  });
});
