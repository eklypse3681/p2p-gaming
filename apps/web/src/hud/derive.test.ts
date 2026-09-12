import { describe, expect, it } from 'vitest';
import {
  makeState,
  movingWhiteActions,
  blackToRollActions,
  freeBoardState,
  A,
} from '../test/state';
import {
  canCommit,
  canDouble,
  canOfferResign,
  canOpeningRoll,
  canRespondToDouble,
  canRoll,
  canStartGame,
  canUndo,
  myTurn,
  pendingResign,
  phaseSummary,
  pips,
  canFreeRoll,
  canRecordResult,
  describeConfig,
  isFreeBoard,
  isFreeMode,
  lastFreeDice,
} from './derive';

describe('derive', () => {
  it('before the first game: start is available once both players are present', () => {
    const s = makeState();
    expect(canStartGame(s)).toBe(true);
    expect(phaseSummary(s).text).toMatch(/start the first game/i);
    const alone = makeState({ noOpponent: true });
    expect(canStartGame(alone)).toBe(false);
    expect(phaseSummary(alone).text).toMatch(/waiting for an opponent/i);
  });

  it('opening roll: each player rolls once', () => {
    const s = makeState({ actions: [A.start] });
    expect(canOpeningRoll(s)).toBe(true);
    expect(myTurn(s)).toBe(true);
    expect(phaseSummary(s)).toMatchObject({ mine: true, text: 'Roll for the opening' });
    const rolled = makeState({ actions: [A.start, A.openW(4)] });
    expect(canOpeningRoll(rolled)).toBe(false);
    expect(phaseSummary(rolled).text).toMatch(/waiting for bob to roll/i);
    const tie = makeState({ actions: [A.start, A.openW(4), A.openB(4)] });
    expect(phaseSummary(tie).text).toMatch(/tie/i);
  });

  it('moving phase for me: commit only when complete, undo only with staged moves', () => {
    const s = makeState({ actions: movingWhiteActions() });
    expect(myTurn(s)).toBe(true);
    expect(canRoll(s)).toBe(false);
    expect(canCommit(s)).toBe(false);
    expect(canUndo(s)).toBe(false);
    expect(s.draft.maxMoves).toBe(2);
    expect(phaseSummary(s).text).toBe('Your move: 3–1');
    const asBlack = makeState({ actions: movingWhiteActions(), seat: 'black' });
    expect(myTurn(asBlack)).toBe(false);
    expect(phaseSummary(asBlack).text).toMatch(/alice is moving 3–1/i);
  });

  it('to-roll: roll and double availability', () => {
    const s = makeState({ actions: blackToRollActions(), seat: 'black' });
    expect(canRoll(s)).toBe(true);
    expect(canDouble(s)).toBe(true);
    expect(phaseSummary(s).text).toMatch(/your roll — or offer a double/i);
    const white = makeState({ actions: blackToRollActions(), seat: 'white' });
    expect(canRoll(white)).toBe(false);
    expect(canDouble(white)).toBe(false);
    expect(canOfferResign(white)).toBe(true);
  });

  it('double offered: only the responder may take/drop', () => {
    const actions = [...blackToRollActions(), { type: 'double', player: 'black' } as const];
    const white = makeState({ actions, seat: 'white' });
    expect(canRespondToDouble(white)).toBe(true);
    expect(phaseSummary(white).text).toMatch(/bob doubles to 2/i);
    const black = makeState({ actions, seat: 'black' });
    expect(canRespondToDouble(black)).toBe(false);
    expect(phaseSummary(black).text).toMatch(/you offered 2/i);
  });

  it('resignation pending', () => {
    const actions = [
      ...blackToRollActions(),
      { type: 'offer-resign', player: 'black', stakes: 'gammon' } as const,
    ];
    const white = makeState({ actions, seat: 'white' });
    expect(pendingResign(white)).toEqual({ by: 'black', stakes: 'gammon' });
    expect(phaseSummary(white).text).toMatch(/offers to resign a gammon/i);
    expect(canOfferResign(white)).toBe(false);
  });

  it('crawford game forbids doubling', () => {
    const s = makeState({ actions: blackToRollActions(), seat: 'black', config: { length: 1 } });
    expect(canDouble(s)).toBe(false);
    expect(phaseSummary(s).text).toBe('Your roll');
  });

  it('pips follow the board', () => {
    expect(pips(makeState({ actions: movingWhiteActions() }))).toEqual({ white: 167, black: 167 });
    expect(pips(makeState({ actions: blackToRollActions() }))).toEqual({ white: 163, black: 167 });
  });

  it('connection states', () => {
    expect(phaseSummary(makeState({ status: 'connecting' })).text).toBe('Connecting…');
    expect(phaseSummary(makeState({ status: 'disconnected' })).text).toBe('Disconnected');
  });

  it('free board: both seats may act, no turn, summary shows the last roll', () => {
    const s = freeBoardState();
    expect(isFreeMode(s)).toBe(true);
    expect(isFreeBoard(s)).toBe(true);
    expect(canFreeRoll(s)).toBe(true);
    expect(canRecordResult(s)).toBe(true);
    expect(canRoll(s)).toBe(false);
    expect(canOpeningRoll(s)).toBe(false);
    expect(canDouble(s)).toBe(false);
    expect(canOfferResign(s)).toBe(true);
    expect(myTurn(s)).toBe(false);
    expect(lastFreeDice(s)).toBeNull();
    expect(phaseSummary(s)).toMatchObject({ mine: true });
    expect(phaseSummary(s).text).toMatch(/free board/i);
    expect(describeConfig(s.snapshot!.match)).toMatch(/free board/i);
    const rolled = freeBoardState({
      seat: 'black',
      actions: [A.start, { type: 'free-roll', player: 'white', dice: [6, 2] }],
    });
    expect(lastFreeDice(rolled)).toEqual({ player: 'white', dice: [6, 2] });
    expect(phaseSummary(rolled).text).toMatch(/alice rolled 6–2/i);
    const enforced = makeState();
    expect(isFreeMode(enforced)).toBe(false);
    expect(canFreeRoll(enforced)).toBe(false);
  });
});

describe('homeSideFor', () => {
  it("mirrors the host's table layout for the seat across", async () => {
    const { homeSideFor } = await import('./derive');
    const base = makeState({ seat: 'white' });
    const withSide = (homeSide: 'left' | 'right', seat: 'white' | 'black') => ({
      ...makeState({ seat }),
      snapshot: { ...base.snapshot!, homeSide },
    });
    expect(homeSideFor(withSide('left', 'white'))).toBe('left');
    expect(homeSideFor(withSide('left', 'black'))).toBe('right');
    expect(homeSideFor(withSide('right', 'white'))).toBe('right');
    expect(homeSideFor(withSide('right', 'black'))).toBe('left');
    expect(homeSideFor(withSide('left', 'white'), 'black')).toBe('right');
    expect(homeSideFor(makeState({ seat: 'black' }))).toBe('right'); // missing field = left for host
    expect(homeSideFor(makeState({ seat: null }))).toBe('left');
  });
});
