import type { ReactNode } from 'react';
import styles from './SettingsScreen.module.css';

/** Controls shared by the general settings and every game's own settings panel. */
export function Switch({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`${styles.switch} ${on ? styles.switchOn : ''}`}
      onClick={() => onChange(!on)}
    />
  );
}

export function SettingRow({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.rowField}>
      <div className={styles.rowText}>
        {title}
        {hint ? <small>{hint}</small> : null}
      </div>
      {children}
    </div>
  );
}
