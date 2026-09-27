import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { PairedDevice } from '../session/profiles';
import type { PairingHost, PairingRequest } from '../session/pairing';
import { hostPairing } from '../session/pairing';
import { pairLink } from '../session/pairLinks';
import { getProvider } from '../session/providers';
import styles from './Handoff.module.css';

type Phase =
  | { kind: 'opening' }
  | { kind: 'waiting'; link: string }
  | { kind: 'asking'; link: string; request: PairingRequest }
  | { kind: 'approving'; request: PairingRequest }
  | { kind: 'paired'; device: PairedDevice }
  | { kind: 'failed'; message: string };

/**
 * Offers to pair another device with this player: a QR code and link to open there, then an
 * approval prompt naming the device. The other device makes its own key and receives a grant;
 * nothing that lets it become the player crosses before the person here approves it.
 */
export function PairOffer({
  slug,
  name,
  next,
  onPaired,
}: {
  slug: string;
  name: string;
  /** Where the new device goes afterwards, inside the player: `ofc/join/ABC234`. */
  next?: string;
  onPaired?: (device: PairedDevice) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'opening' });
  const [svg, setSvg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let host: PairingHost | null = null;
    let active = true;
    hostPairing(slug, getProvider(slug, 'pair'))
      .then((h) => {
        if (!active) return h.close();
        host = h;
        const link = pairLink(h.code, next);
        setPhase({ kind: 'waiting', link });
        h.onRequest((request) => {
          setPhase({ kind: 'asking', link, request });
          // A device that left before an answer is not worth asking about any more.
          request.onWithdrawn(() =>
            setPhase((p) =>
              p.kind === 'asking' && p.request === request ? { kind: 'waiting', link } : p,
            ),
          );
        });
      })
      .catch((e: unknown) =>
        setPhase({ kind: 'failed', message: e instanceof Error ? e.message : 'Could not open' }),
      );
    return () => {
      active = false;
      host?.close();
    };
  }, [slug, next]);

  const link = phase.kind === 'waiting' || phase.kind === 'asking' ? phase.link : null;
  useEffect(() => {
    if (!link) return;
    let active = true;
    QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
      .then((markup) => active && setSvg(markup))
      .catch(() => active && setSvg(null));
    return () => {
      active = false;
    };
  }, [link]);

  const approve = (request: PairingRequest) => {
    setPhase({ kind: 'approving', request });
    request
      .approve()
      .then((device) => {
        setPhase({ kind: 'paired', device });
        onPaired?.(device);
      })
      .catch(() => setPhase({ kind: 'failed', message: 'Pairing did not finish. Try again.' }));
  };

  if (phase.kind === 'opening') {
    return <p className="muted small">Opening a pairing code…</p>;
  }
  if (phase.kind === 'failed') {
    return (
      <p className="error-text" role="alert" data-testid="pair-failed">
        {phase.message}
      </p>
    );
  }
  if (phase.kind === 'paired') {
    return (
      <p className="small" role="status" data-testid="pair-done">
        {phase.device.label} is now {name}. It holds its own key, never yours.
      </p>
    );
  }
  if (phase.kind === 'asking' || phase.kind === 'approving') {
    const { request } = phase;
    return (
      <div className={styles.wrap} data-testid="pair-request">
        <div className="eyebrow">Pair this device?</div>
        <p>
          <strong>{request.label}</strong> wants to play as {name}.
        </p>
        <p className="muted small">
          It should be showing <code data-testid="pair-fingerprint">{request.fingerprint}</code>.
        </p>
        <div className="row" style={{ justifyContent: 'center' }}>
          <button
            className="btn btn-primary btn-sm"
            disabled={phase.kind === 'approving'}
            onClick={() => approve(request)}
            data-testid="pair-approve"
          >
            Approve
          </button>
          <button
            className="btn btn-ghost btn-sm"
            disabled={phase.kind === 'approving'}
            onClick={() => {
              request.decline();
              setPhase({ kind: 'failed', message: 'Declined.' });
            }}
            data-testid="pair-decline"
          >
            Decline
          </button>
        </div>
      </div>
    );
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(phase.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked: the link field is selectable */
    }
  };
  return (
    <div className={styles.wrap} data-testid="pair-offer">
      <div
        className={styles.qr}
        data-testid="pair-qr"
        role="img"
        aria-label={`QR code that pairs another device with ${name}`}
        // The markup is generated locally from our own link by the qrcode library.
        dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
      />
      <p className="muted small">
        Scan it on the other device, then approve it here. Nothing it shows can be used by anyone
        else.
      </p>
      <div className={styles.linkRow}>
        <input
          className={`input ${styles.link}`}
          readOnly
          value={phase.link}
          aria-label="Pairing link"
          onFocus={(e) => e.currentTarget.select()}
          data-testid="pair-link"
        />
        <button className="btn btn-sm" type="button" onClick={copy} data-testid="copy-pair-link">
          {copied ? 'Copied!' : 'Copy link'}
        </button>
      </div>
    </div>
  );
}
