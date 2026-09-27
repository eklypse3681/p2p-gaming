import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import type { JoinPhase, PairingJoin } from '../session/pairing';
import { joinPairing } from '../session/pairing';
import { isSafeNext } from '../session/pairLinks';
import { getProvider } from '../session/providers';

/**
 * `#/pair/<code>`: this device asks to become a player whose other device is showing the code.
 * It makes its own key here and shows its fingerprint; the other device approves and sends back
 * a grant. Then it goes wherever the link said (`?next=`), inside that player.
 */
export function PairScreen() {
  const { code = '' } = useParams<{ code: string }>();
  const [search] = useSearchParams();
  const next = search.get('next');
  const navigate = useNavigate();
  const [join, setJoin] = useState<PairingJoin | null>(null);
  const [phase, setPhase] = useState<JoinPhase>({ phase: 'connecting' });

  useEffect(() => {
    let active = true;
    let current: PairingJoin | null = null;
    let finished = false;
    let unsubscribe = () => {};
    joinPairing(code.toUpperCase(), getProvider('', 'pair')).then((j) => {
      if (!active) return j.cancel();
      current = j;
      setJoin(j);
      unsubscribe = j.onPhase((p) => {
        finished = p.phase === 'paired' || p.phase === 'failed';
        setPhase(p);
      });
      j.done
        .then((slug) => {
          if (active) navigate(`/${slug}/${isSafeNext(next) ? next : ''}`, { replace: true });
        })
        .catch(() => {});
    });
    return () => {
      active = false;
      unsubscribe();
      if (current && !finished) current.cancel();
    };
  }, [code, next, navigate]);

  return (
    <div className="page page-narrow" data-testid="pair-screen" data-phase={phase.phase}>
      <div className="stack">
        <div>
          <div className="eyebrow">Pair this device</div>
          <h1>
            {phase.phase === 'waiting' || phase.phase === 'paired'
              ? `Play as ${phase.player.name}`
              : 'Connecting…'}
          </h1>
        </div>
        <section className="card stack">
          {phase.phase === 'connecting' && <p className="muted">Reaching your other device…</p>}
          {phase.phase === 'waiting' && (
            <>
              <p>Approve this device on {phase.player.name}’s other screen.</p>
              <p className="muted small">
                It will show <code data-testid="my-fingerprint">{phase.fingerprint}</code>. This
                device gets its own key; {phase.player.name}’s never leaves the other one.
              </p>
            </>
          )}
          {phase.phase === 'paired' && <p role="status">Paired. Opening…</p>}
          {phase.phase === 'failed' && (
            <p className="error-text" role="alert" data-testid="pair-error">
              {phase.error.code === 'declined'
                ? 'The other device declined.'
                : phase.error.code === 'closed'
                  ? 'That pairing code is closed. Open a new one on your other device.'
                  : 'This device could not be paired.'}
            </p>
          )}
          {join && phase.phase !== 'failed' && phase.phase !== 'paired' && (
            <p className="muted small">This device: {join.fingerprint}</p>
          )}
        </section>
      </div>
    </div>
  );
}
