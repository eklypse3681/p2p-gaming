import { useEffect } from 'react';

export interface ShortcutHandlers {
  roll?: () => void;
  double?: () => void;
  done?: () => void;
  undo?: () => void;
  escape?: () => void;
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** R roll · D double · Enter done · U / Backspace undo · Esc clear selection. */
export function useKeyboardShortcuts(h: ShortcutHandlers, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target)) return;
      switch (e.key) {
        case 'r':
        case 'R':
          if (h.roll) {
            e.preventDefault();
            h.roll();
          }
          break;
        case 'd':
        case 'D':
          if (h.double) {
            e.preventDefault();
            h.double();
          }
          break;
        case 'Enter':
          if (h.done) {
            e.preventDefault();
            h.done();
          }
          break;
        case 'u':
        case 'U':
        case 'Backspace':
          if (h.undo) {
            e.preventDefault();
            h.undo();
          }
          break;
        case 'Escape':
          if (h.escape) {
            e.preventDefault();
            h.escape();
          }
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [h, enabled]);
}
