import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Variant } from '@bgf/ofc-engine';
import { OfcTable } from '../table/OfcTable';
import { FakeOfcClient } from './fakeOfcClient';
import styles from './OfcTableDemo.module.css';

export interface OfcTableDemoProps {
  initialVariant?: Variant;
  initialSeats?: 2 | 3;
  /** Bots act instantly (tests). */
  instant?: boolean;
}

/**
 * Standalone, profile-less table for trying the OFC screen: the local player at seat 0 against
 * one or two bots driven by the engine. Mounted by the shell at `#/ofc/demo`.
 */
export function OfcTableDemo({
  initialVariant = 'pineapple',
  initialSeats = 3,
  instant = false,
}: OfcTableDemoProps) {
  const [variant, setVariant] = useState<Variant>(initialVariant);
  const [seats, setSeats] = useState<2 | 3>(initialSeats);
  const [buyIn, setBuyIn] = useState(false);
  const [autoPlay, setAutoPlay] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [fourColor, setFourColor] = useState(false);
  const [fantasyland, setFantasyland] = useState(false);
  const [generation, setGeneration] = useState(0);

  const client = useMemo(
    () =>
      new FakeOfcClient({
        config: {
          variant,
          seats,
          scoring: buyIn
            ? { mode: 'buyin', buyIn: 100, multiplier: 0.25 }
            : { mode: 'up', multiplier: 1 },
        },
        seed: 11 + generation,
        botDelayMs: instant ? 0 : 450,
        autoPlay,
        fantasylandForMe: fantasyland ? (variant === 'ofc' ? 13 : 14) : 0,
      }),
    // A new table whenever the setup changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [variant, seats, buyIn, generation, instant, fantasyland],
  );
  useEffect(() => () => client.close(), [client]);
  useEffect(() => {
    client.setAutoPlay(autoPlay);
  }, [client, autoPlay]);

  const state = useSyncExternalStore(
    (l) => client.subscribe(l),
    () => client.getState(),
    () => client.getState(),
  );

  return (
    <div className={styles.demo} data-testid="ofc-demo">
      <div className={styles.toolbar}>
        <label>
          Variant
          <select
            value={variant}
            onChange={(e) => setVariant(e.target.value as Variant)}
            data-testid="demo-variant"
          >
            <option value="ofc">OFC</option>
            <option value="pineapple">Pineapple</option>
            <option value="pineapple27">Pineapple 2-7</option>
          </select>
        </label>
        <label>
          Seats
          <select
            value={seats}
            onChange={(e) => setSeats(Number(e.target.value) as 2 | 3)}
            data-testid="demo-seats"
          >
            <option value={2}>2</option>
            <option value={3}>3</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={buyIn}
            onChange={(e) => setBuyIn(e.target.checked)}
            data-testid="demo-buyin"
          />{' '}
          Buy-in 100 · ×0.25
        </label>
        <label>
          <input
            type="checkbox"
            checked={autoPlay}
            onChange={(e) => setAutoPlay(e.target.checked)}
            data-testid="demo-autoplay"
          />{' '}
          Auto-play others
        </label>
        <label>
          <input
            type="checkbox"
            checked={fantasyland}
            onChange={(e) => setFantasyland(e.target.checked)}
            data-testid="demo-fantasyland"
          />{' '}
          Fantasyland for me
        </label>
        <label>
          <input
            type="checkbox"
            checked={fourColor}
            onChange={(e) => setFourColor(e.target.checked)}
            data-testid="demo-four-color"
          />{' '}
          Four-colour deck
        </label>
        <label>
          <input
            type="checkbox"
            checked={reducedMotion}
            onChange={(e) => setReducedMotion(e.target.checked)}
            data-testid="demo-reduced-motion"
          />{' '}
          Reduced motion
        </label>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setGeneration((g) => g + 1)}
          data-testid="demo-reset"
        >
          New table
        </button>
        {!autoPlay && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => client.playBots()}
            data-testid="demo-play-bots"
          >
            Play bots
          </button>
        )}
      </div>
      <div className={styles.tableWrap}>
        <OfcTable
          state={state}
          send={client.send}
          names={client.names}
          mySeat={client.mySeat}
          reducedMotion={reducedMotion}
          fourColor={fourColor}
        />
      </div>
    </div>
  );
}
