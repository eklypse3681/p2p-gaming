import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { handoffLink } from '../session/links';
import { useProfile } from '../session/ProfileProvider';
import { useOptionalGame } from '../games/GameProvider';
import styles from './Handoff.module.css';

/**
 * "Move to another device": a QR code (and the link behind it) that opens this match on a phone
 * *as the same player*. The link is a join link carrying the player's identity, so the phone
 * skips the picker and takes a second connection on the same seat; both devices then receive
 * every state until one of them leaves.
 */
export function Handoff({ code }: { code: string }) {
  const { profile } = useProfile();
  const game = useOptionalGame();
  const link = useMemo(() => handoffLink(code, profile, game?.id), [code, profile, game?.id]);
  const [svg, setSvg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
      .then((markup) => {
        if (active) setSvg(markup);
      })
      .catch(() => {
        if (active) setSvg(null);
      });
    return () => {
      active = false;
    };
  }, [link]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked: the link field is selectable */
    }
  };

  return (
    <div className={styles.wrap} data-testid="handoff-panel">
      <div className="eyebrow">Move to another device</div>
      <div
        className={styles.qr}
        data-testid="handoff-qr"
        role="img"
        aria-label={`QR code that opens this match as ${profile.name} on another device`}
        // The markup is generated locally from our own link by the qrcode library.
        dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
      />
      <p className="muted small">
        Scan with your phone to keep playing there. Both devices stay in the game until you close
        one.
      </p>
      <div className={styles.linkRow}>
        <input
          className={`input ${styles.link}`}
          readOnly
          value={link}
          aria-label="Hand-off link"
          onFocus={(e) => e.currentTarget.select()}
          data-testid="handoff-link"
        />
        <button className="btn btn-sm" type="button" onClick={copy} data-testid="copy-handoff">
          {copied ? 'Copied!' : 'Copy link'}
        </button>
      </div>
    </div>
  );
}
