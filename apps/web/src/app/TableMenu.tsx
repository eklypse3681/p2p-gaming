import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import styles from './AppBar.module.css';

/**
 * The ⋮ menu in the title bar: a table screen registers what belongs there (move to another
 * device, ledger, fairness, table & chat, leave) and the app bar shows the button while it does.
 */
export interface TableMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  /** Leave and the like: set apart at the bottom. */
  quiet?: boolean;
}

interface Registry {
  set(items: TableMenuItem[] | null): void;
}

const SetCtx = createContext<Registry | null>(null);
const ItemsCtx = createContext<TableMenuItem[] | null>(null);

export function TableMenuProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<TableMenuItem[] | null>(null);
  // Handlers change every render; only re-render the bar when what it shows changes.
  const handlers = useRef(new Map<string, () => void>());
  const shown = useRef('');
  const registry = useMemo<Registry>(
    () => ({
      set(next) {
        handlers.current = new Map((next ?? []).map((i) => [i.id, i.onSelect]));
        const key = next ? next.map((i) => `${i.id}:${i.label}:${i.quiet ? 1 : 0}`).join('|') : '';
        if (key === shown.current) return;
        shown.current = key;
        setItems(
          next ? next.map((i) => ({ ...i, onSelect: () => handlers.current.get(i.id)?.() })) : null,
        );
      },
    }),
    [],
  );
  return (
    <SetCtx.Provider value={registry}>
      <ItemsCtx.Provider value={items}>{children}</ItemsCtx.Provider>
    </SetCtx.Provider>
  );
}

/** Put `items` in the ⋮ menu while the calling screen is mounted. */
export function useTableMenu(items: TableMenuItem[]): void {
  const registry = useContext(SetCtx);
  useEffect(() => {
    registry?.set(items);
  });
  useEffect(() => () => registry?.set(null), [registry]);
}

/** The ⋮ button and its list; nothing when no screen has registered items. */
export function TableMenuButton() {
  const items = useContext(ItemsCtx);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const toggle = () => {
    // Positioned on the page, not inside the bar (which clips what overflows it).
    const r = ref.current?.getBoundingClientRect();
    if (r) setAt({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    setOpen((v) => !v);
  };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  if (!items || items.length === 0) return null;
  const main = items.filter((i) => !i.quiet);
  const quiet = items.filter((i) => i.quiet);
  return (
    <div className={styles.tableMenu} ref={ref}>
      <button
        type="button"
        className="btn btn-ghost btn-icon btn-sm"
        aria-label="Table menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        data-testid="table-menu-button"
      >
        <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
          <circle cx="10" cy="4.5" r="1.7" fill="currentColor" />
          <circle cx="10" cy="10" r="1.7" fill="currentColor" />
          <circle cx="10" cy="15.5" r="1.7" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div
          className={styles.tableMenuList}
          role="menu"
          data-testid="table-menu"
          style={at ? { top: at.top, right: at.right } : undefined}
        >
          {[...main, ...(quiet.length ? [null] : []), ...quiet].map((i, n) =>
            i ? (
              <button
                key={i.id}
                type="button"
                role="menuitem"
                className={styles.tableMenuItem}
                data-testid={`menu-${i.id}`}
                onClick={() => {
                  setOpen(false);
                  i.onSelect();
                }}
              >
                {i.label}
              </button>
            ) : (
              <hr key={`sep-${n}`} className={styles.tableMenuSep} />
            ),
          )}
        </div>
      )}
    </div>
  );
}
