import { useState } from 'react';
import { joinLink } from '../session/links';
import { useOptionalGame } from '../games/GameProvider';
import styles from './RoomCode.module.css';

export function RoomCode({ code }: { code: string }) {
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const game = useOptionalGame();
  const link = joinLink(code, game?.id);
  const copy = async (what: 'code' | 'link') => {
    const text = what === 'code' ? code : link;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      /* clipboard blocked: the code is selectable */
    }
  };
  const share = async () => {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'Play backgammon with me', url: link });
      } catch {
        /* cancelled */
      }
    } else {
      await copy('link');
    }
  };
  return (
    <div className={styles.wrap} data-testid="room-code-panel">
      <div className="eyebrow">Room code</div>
      <div
        className={styles.code}
        data-testid="room-code"
        aria-label={`Room code ${code.split('').join(' ')}`}
      >
        {code}
      </div>
      <p className="muted small">
        Share this code or the link. Your opponent joins from the home screen.
      </p>
      <div className={styles.actions}>
        <button className="btn btn-sm" onClick={() => copy('code')} data-testid="copy-code">
          {copied === 'code' ? 'Copied!' : 'Copy code'}
        </button>
        <button
          className="btn btn-sm btn-primary"
          onClick={() => copy('link')}
          data-testid="copy-link"
        >
          {copied === 'link' ? 'Copied!' : 'Copy link'}
        </button>
        <button className="btn btn-sm btn-ghost" onClick={share}>
          Share…
        </button>
      </div>
    </div>
  );
}
