/** Props that make a score open the ledger when tapped (or Enter/Space), or nothing. */
export function scoreLink(onOpen?: () => void) {
  if (!onOpen) return {};
  return {
    role: 'button',
    tabIndex: 0,
    'data-opens-ledger': 'true',
    onClick: (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      onOpen();
    },
    onKeyDown: (e: { key: string; preventDefault: () => void }) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onOpen();
      }
    },
  } as const;
}
