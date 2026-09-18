'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * A QR code for a link, drawn in the browser.
 *
 * Generated here rather than fetched from a service: the link inside it is a
 * connect code that proves ownership of a chat, and sending that to a third
 * party to draw a picture of would hand them the proof.
 *
 * Renders nothing until the image exists, so a phone camera never sees a
 * half-drawn code.
 */
export function Qr({ value, label, size = 168 }: { value: string; label: string; size?: number }) {
  const [src, setSrc] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, {
      margin: 1,
      width: size * 2,
      errorCorrectionLevel: 'M',
      // Dark modules on a white tile: the highest contrast a phone camera can
      // get, and the same in both themes.
      color: { dark: '#0b111c', light: '#ffffff' },
    })
      .then((url) => { if (!cancelled) setSrc(url); })
      .catch(() => { if (!cancelled) setSrc(undefined); });
    return () => { cancelled = true; };
  }, [value, size]);

  if (src === undefined) return <span className="qr" style={{ width: size, height: size }} aria-hidden />;

  return (
    <span className="qr" style={{ width: size, height: size }}>
      <img src={src} width={size} height={size} alt={label} />
    </span>
  );
}
