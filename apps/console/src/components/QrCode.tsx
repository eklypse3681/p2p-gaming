import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export function QrCode({ value }: { value: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let alive = true;
    QRCode.toString(value, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
      .then((s) => alive && setSvg(s))
      .catch(() => alive && setSvg(''));
    return () => {
      alive = false;
    };
  }, [value]);
  if (!svg) return <div className="qr" data-testid="qr" />;
  // The markup comes from the qrcode library rendering our own link.
  return <div className="qr" data-testid="qr" dangerouslySetInnerHTML={{ __html: svg }} />;
}
