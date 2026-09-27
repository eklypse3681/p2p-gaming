import { useProfile } from '../session/ProfileProvider';
import { isPairedDevice } from '../session/profiles';
import { canPairDevices } from '../session/pairing';
import { useOptionalGame } from '../games/GameProvider';
import { DEFAULT_GAME } from '../games/ids';
import { PairOffer } from './PairOffer';
import styles from './Handoff.module.css';

/**
 * "Move to another device": pair a phone with this player and open this match on it. The phone
 * makes its own key and is approved from here, then joins the same seat; both devices receive
 * every state until one of them leaves. A phone paired before is simply approved again.
 */
export function Handoff({ code }: { code: string }) {
  const { profile, slug, record } = useProfile();
  const game = useOptionalGame();
  const next = `${game?.id ?? DEFAULT_GAME}/join/${code}`;
  if (isPairedDevice(record) || !canPairDevices(slug)) {
    return (
      <div className={styles.wrap} data-testid="handoff-panel">
        <div className="eyebrow">Move to another device</div>
        <p className="muted small">
          Open this match from the device that holds {profile.name}’s own key to add another one.
        </p>
      </div>
    );
  }
  return (
    <div className={styles.wrap} data-testid="handoff-panel">
      <div className="eyebrow">Move to another device</div>
      <PairOffer slug={slug} name={profile.name} next={next} />
      <p className="muted small">
        Scan with your phone to keep playing there. Both devices stay in the game until you close
        one.
      </p>
    </div>
  );
}
