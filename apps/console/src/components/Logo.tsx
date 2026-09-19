export function Logo() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="var(--ui-surface-raised)" />
      <polygon points="8,8 20,8 14,40" fill="var(--ui-accent)" />
      <polygon points="22,8 34,8 28,40" fill="var(--ui-text-muted)" />
      <polygon points="36,8 48,8 42,40" fill="var(--ui-accent)" />
      <circle cx="42" cy="50" r="7" fill="var(--ui-text)" />
    </svg>
  );
}
