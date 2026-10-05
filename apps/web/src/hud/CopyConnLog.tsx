import { useState } from 'react';
import { shareConnLog } from '../session/connLog';

/** Copies this device's connection log so a player can paste it into a bug report. */
export function CopyConnLog({
  className = 'btn btn-ghost btn-sm',
  label = 'Copy connection log',
}: {
  className?: string;
  label?: string;
}) {
  const [result, setResult] = useState<'copied' | 'shared' | 'failed' | null>(null);
  return (
    <button
      className={className}
      onClick={() => void shareConnLog().then(setResult)}
      data-testid="copy-conn-log"
    >
      {result === 'copied'
        ? 'Log copied'
        : result === 'shared'
          ? 'Log shared'
          : result === 'failed'
            ? 'Could not copy'
            : label}
    </button>
  );
}
